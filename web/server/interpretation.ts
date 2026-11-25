import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Language } from '../shared/language.ts'
import type { Provider } from '../shared/providers.ts'

const keyFiles = {
  openai: { env: 'OPENAI_API_KEY_FILE', name: 'openai-api-key' },
  claude: { env: 'ANTHROPIC_API_KEY_FILE', name: 'anthropic-api-key' },
} as const

const openAIQuotaCodes = new Set([
  'insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_exhausted',
  'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
])

// Only use fixed, user-facing messages for errors that cross the worker boundary.
export class InterpretationProviderError extends Error {}

type InterpretationInput = {
  sport: string
  metrics: Record<string, unknown>
  laps: Record<string, unknown>[]
  observations: string[]
}

const measurementKeys = [
  'distanceM', 'activeSeconds', 'elapsedSeconds', 'avgHr', 'maxHr',
  'ascentM', 'descentM', 'paceSecondsPerKm', 'avgPowerW', 'maxPowerW',
  'avgCadence', 'energyKcal', 'pauseSeconds', 'hrTss', 'temperatureC',
  'recoverySeconds', 'recordCount', 'activeHrSampleCount',
]

const lapKeys = [
  'index', 'distanceM', 'activeSeconds', 'elapsedSeconds', 'avgHr', 'maxHr',
  'avgPowerW', 'ascentM', 'descentM', 'paceSecondsPerKm',
]

const sports = new Set([
  'running', 'trail running', 'walking', 'hiking', 'cycling', 'mountain biking',
  'swimming', 'pool swimming', 'open water swimming', 'strength training',
  'cross-country skiing', 'indoor cycling', 'treadmill', 'triathlon',
])

function localKeyFile(provider: Provider) {
  const directory = process.env.SUUNTO_PRIVATE_DIR
  return directory ? join(directory, keyFiles[provider].name) : undefined
}

function apiKey(provider: Provider): string | undefined {
  const file = process.env[keyFiles[provider].env] || localKeyFile(provider)
  if (!file) return undefined
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

export function interpretationConfigured(provider: Provider): boolean {
  return Boolean(apiKey(provider))
}

export type AISettings = { configured: boolean; editable: boolean }

export function readAISettings(provider: Provider): AISettings {
  return {
    configured: interpretationConfigured(provider),
    editable: !process.env[keyFiles[provider].env] && Boolean(localKeyFile(provider)),
  }
}

function editableKeyFile(provider: Provider) {
  const file = localKeyFile(provider)
  if (process.env[keyFiles[provider].env] || !file) {
    throw Object.assign(new Error('AI settings are managed by the worker configuration.'), { code: 'SETTINGS_MANAGED' })
  }
  return file
}

export async function removeAIKey(provider: Provider): Promise<AISettings> {
  await rm(editableKeyFile(provider), { force: true })
  return readAISettings(provider)
}

export async function saveAIKey(provider: Provider, payload: unknown): Promise<AISettings> {
  const file = editableKeyFile(provider)
  const key = typeof payload === 'object' && payload !== null && 'apiKey' in payload
    && typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
  if (!/^[!-~]{1,1024}$/.test(key)) {
    throw Object.assign(new Error('Invalid API key.'), { code: 'SETTINGS_INVALID' })
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, key + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
  return readAISettings(provider)
}

function measurements(record: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : []
  }))
}

export async function interpretWorkout(workout: InterpretationInput, signal?: AbortSignal, language: Language = 'en', provider: Provider = 'openai'): Promise<string> {
  const key = apiKey(provider)
  if (!key) throw new Error('AI interpretation requires an API key.')

  // The provider receives allowlisted measurements, never raw records or user-supplied text.
  const sport = workout.sport.toLowerCase()
  const input = {
    sport: sports.has(sport) ? sport : undefined,
    metrics: measurements(workout.metrics, measurementKeys),
    cadenceUnit: ['spm', 'rpm'].find((unit) => unit === workout.metrics.cadenceUnit),
    lapCount: workout.laps.length,
    laps: workout.laps.slice(0, 100).map((lap) => measurements(lap, lapKeys)),
  }

  const instructions = [
    `Briefly interpret the activity in ${language === 'pl' ? 'Polish' : 'English'}. Use plain text and short paragraphs.`,
    'Explain what the available data show and cite specific measurements or laps.',
    'Omitted fields indicate missing measurements. Note if only part of the lap data was provided.',
    'Do not infer a goal, heart-rate zones, causes, or other unavailable information.',
    'Avoid diagnoses and medical advice. Use min/km for pace when appropriate for the sport.',
  ].join(' ')

  const timeout = AbortSignal.timeout(45_000)
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout
  const measurementsJson = JSON.stringify(input)
  if (provider === 'claude') {
    return claudeInterpretation(key, instructions, measurementsJson, requestSignal)
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: requestSignal,
    body: JSON.stringify({
      model: process.env.SUUNTO_WEB_OPENAI_MODEL || 'gpt-6.1-terra',
      store: false,
      max_output_tokens: 1200,
      instructions,
      input: measurementsJson,
    }),
  })
  if (!response.ok) {
    if (response.status === 429) {
      const body = await response.json().catch(() => null) as { error?: { code?: string; type?: string } } | null
      if (openAIQuotaCodes.has(body?.error?.code ?? '') || openAIQuotaCodes.has(body?.error?.type ?? '')) {
        throw new InterpretationProviderError('OpenAI API quota is unavailable. Check your API credit balance and spending limits.')
      }
    } else {
      await response.body?.cancel()
    }
    throw new Error(`OpenAI rejected the request (HTTP ${response.status}).`)
  }

  const result = await response.json() as {
    status?: string
    output?: { type: string; content?: { type: string; text?: string }[] }[]
  }
  const text = result.output
    ?.filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
  if (result.status !== 'completed' || !text) {
    throw new Error('OpenAI did not return a complete interpretation.')
  }
  return text
}

async function claudeInterpretation(key: string, instructions: string, input: string, signal: AbortSignal) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2026-10-21',
    },
    redirect: 'error',
    signal,
    body: JSON.stringify({
      model: process.env.SUUNTO_WEB_CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 1600,
      output_config: { effort: 'low' },
      system: instructions,
      messages: [{ role: 'user', content: input }],
    }),
  })
  if (!response.ok) {
    if (response.status === 400) {
      const body = await response.json().catch(() => null) as { error?: { type?: string; message?: unknown } } | null
      const message = body?.error?.message
      if (body?.error?.type === 'invalid_request_error' && typeof message === 'string'
        && /\bcredit balance\b/i.test(message) && /\b(too low|insufficient|exhausted|purchase credits)\b/i.test(message)) {
        throw new InterpretationProviderError('Claude API credit balance is too low. Check billing in Claude Console.')
      }
    } else {
      await response.body?.cancel()
      if (response.status === 401) {
        throw new InterpretationProviderError('Claude rejected the API key. Check your key in Claude Console and update it in app settings.')
      }
    }
    throw new Error(`Claude rejected the request (HTTP ${response.status}).`)
  }
  const result = await response.json() as {
    stop_reason?: string
    content?: { type: string; text?: string }[]
  }
  const text = result.content
    ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
  if (result.stop_reason !== 'end_turn' || !text) {
    throw new Error('Claude did not return a complete interpretation.')
  }
  return text
}
