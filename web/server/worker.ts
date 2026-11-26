import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startAuthChannel } from './auth-channel.ts';
import type { SuuntoSettings } from './auth-channel.ts';
import type { Analysis, CloudIndex } from './contracts.ts';
import { providers } from '../shared/providers.ts';
import {
  InterpretationProviderError, interpretationConfigured, interpretWorkout, readAISettings, removeAIKey, saveAIKey,
} from './interpretation.ts';
import { artifactDirectory, isId, Store, uploadDirectory } from './store.ts';
import type { Job } from './store.ts';

const overlap = 2 * 24 * 60 * 60 * 1_000;
const leaseDuration = 18_000;
const cloudInterval = 6_500;
const bridgeScript = fileURLToPath(new URL('../../suunto_cloud/web_bridge.mjs', import.meta.url));
const cloudErrors: Record<string, string> = {
  AUTH_REQUIRED: 'Connect Suunto and try synchronizing again.',
  RATE_LIMIT: 'Suunto has limited requests. Import will resume automatically.',
  NETWORK: 'Suunto is temporarily unreachable.',
  FIT_UNAVAILABLE: 'Suunto has no FIT file for this workout.',
  INVALID_FIT: 'This FIT file is unreadable or is not a supported single-session workout.',
  ANALYSIS_FAILED: 'The workout could not be analyzed.',
  SETTINGS_INVALID: 'Check the Suunto client ID, secret and subscription key.',
};

class JobError extends Error {
  code: string;
  retryAfterMs?: number;

  constructor(code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function bridge<T>(args: string[], signal: AbortSignal, input?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [bridgeScript, ...args], {
      encoding: 'utf8',
      timeout: 30 * 60 * 1_000,
      maxBuffer: 32 * 1024 * 1024,
      signal,
      env: { ...process.env, SUUNTO_REQUEST_INTERVAL_MS: String(cloudInterval) },
    }, (error, output) => {
      let result;
      try {
        result = JSON.parse(output);
      } catch {
        reject(new JobError('ANALYSIS_FAILED', 'The analyzer did not return a result.'));
        return;
      }
      if (error || result?.error) {
        const code = result?.error?.code;
        const safeCode = typeof code === 'string' && Object.hasOwn(cloudErrors, code) ? code : 'ANALYSIS_FAILED';
        const delay = result?.error?.retryAfterMs;
        const retryAfterMs = Number.isSafeInteger(delay) && delay > 0
          ? Math.min(delay, 7 * 24 * 60 * 60 * 1_000)
          : undefined;
        reject(new JobError(safeCode, cloudErrors[safeCode], retryAfterMs));
        return;
      }
      resolve(result as T);
    });
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', reject);
      child.stdin.end(input);
    }
  });
}

async function synchronize(store: Store, job: Job, signal: AbortSignal) {
  const watermark = store.setting<number | null>('syncWatermark', null);
  const scope = watermark === null ? ['--since-days', '30'] :
    ['--modified-since', String(Math.max(0, watermark - overlap))];
  const index = await bridge<CloudIndex>(['list', ...scope], signal);
  if (!Array.isArray(index.workouts) || !Number.isSafeInteger(index.highWatermark) || index.highWatermark < 0) {
    throw new JobError('ANALYSIS_FAILED', 'Suunto returned an invalid activity list.');
  }
  store.finishSync(job, index, Date.now());
}

async function analyze(store: Store, job: Job, signal: AbortSignal) {
  const row = store.workout(job.workout_id ?? '');
  const workspace = join(artifactDirectory, job.lease);
  if (!row || row.id !== job.workout_id) {
    throw new JobError('ANALYSIS_FAILED', 'This workout has been replaced by its matching Suunto activity.');
  }
  const args = ['analyze', '--workspace', workspace];
  await mkdir(workspace, { mode: 0o700 });
  let published = false;
  try {
    if (row.source === 'suunto' && row.cloud_json) {
      const cloudFile = join(workspace, 'metadata.json');
      await writeFile(cloudFile, row.cloud_json, { mode: 0o600, flag: 'wx' });
      args.push('--cloud', cloudFile);
    } else if (row.upload_id && isId(row.upload_id)) {
      args.push('--fit', join(uploadDirectory, row.upload_id + '.fit'));
    } else {
      throw new JobError('ANALYSIS_FAILED', 'The workout source is missing.');
    }
    const result = await bridge<Analysis>(args, signal);
    if (!Number.isSafeInteger(result.summary?.startedAt) || typeof result.summary.sport !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.fitSha256) || !Array.isArray(result.observations) ||
        !Array.isArray(result.laps) || typeof result.chart !== 'boolean') {
      throw new JobError('ANALYSIS_FAILED', 'The analyzer returned an invalid workout.');
    }
    if (!(await stat(join(workspace, 'source.fit'))).isFile() ||
        (result.chart && !(await stat(join(workspace, 'chart.html'))).isFile())) {
      throw new JobError('ANALYSIS_FAILED', 'The analysis is missing a stored artifact.');
    }
    await rm(join(workspace, 'metadata.json'), { force: true });
    published = store.finishAnalysis(job, result, row.cloud_json, Date.now());
    if (published && row.artifact_id && isId(row.artifact_id)) {
      await rm(join(artifactDirectory, row.artifact_id), { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    if (!published) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function interpret(store: Store, job: Job, signal: AbortSignal) {
  if (job.attempts > 1) {
    throw new JobError('INTERPRETATION_INTERRUPTED', 'The previous request was interrupted. Request a new interpretation.');
  }
  const input = store.analysisInput(job.workout_id ?? '', job.analysis_version);
  if (!input) throw new JobError('STALE', 'The workout analysis changed. Request a new interpretation.');
  try {
    const text = await interpretWorkout(input, signal, job.language, job.provider);
    store.finishInterpretation(job, text, Date.now());
  } catch (error) {
    if (error instanceof InterpretationProviderError) throw new JobError('INTERPRETATION_PROVIDER', error.message);
    throw new JobError('INTERPRETATION_FAILED', 'Interpretation could not be generated. Try again later.');
  }
}

async function processJob(store: Store, job: Job, shutdown: AbortSignal) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, shutdown]);
  const clock = setInterval(() => {
    try {
      if (!store.extend(job, Date.now(), leaseDuration)) lifetime.abort();
    } catch {
      lifetime.abort();
    }
  }, 4_000);
  try {
    switch (job.kind) {
      case 'sync': await synchronize(store, job, signal); break;
      case 'analyze': await analyze(store, job, signal); break;
      case 'interpret': await interpret(store, job, signal); break;
    }
  } catch (error) {
    if (!signal.aborted) {
      const failure = error instanceof JobError ? error :
        new JobError('ANALYSIS_FAILED', 'The workout job could not finish.');
      store.failed(job, failure, Date.now());
    }
  } finally {
    clearInterval(clock);
  }
}

async function main() {
  process.umask(0o077);
  const shutdown = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT'] as const) process.once(event, () => shutdown.abort());
  const store = new Store();
  const channel = await startAuthChannel((command, body) => bridge<SuuntoSettings>(
    [command], AbortSignal.any([shutdown.signal, AbortSignal.timeout(4_500)]), body,
  ), async (provider, action, update) => {
    if (action === 'read') return readAISettings(provider);
    const settings = action === 'remove' ? await removeAIKey(provider) : await saveAIKey(provider, update);
    store.setInterpretationAvailable(provider, settings.configured);
    return settings;
  });
  try {
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    let nextAuthCheck = 0;
    let nextCloudAt = 0;
    while (!shutdown.signal.aborted) {
      const now = Date.now();
      if (now >= nextAuthCheck) {
        for (const provider of providers) store.setInterpretationAvailable(provider, interpretationConfigured(provider));
        const auth = await bridge<{ revision: string | null; timeZone: string }>(
          ['auth-status'], shutdown.signal,
        ).catch(() => null);
        if (auth) {
          if (auth.timeZone !== store.setting('timeZone', null)) store.setSetting('timeZone', auth.timeZone);
          store.observeAuthorization(auth.revision, now);
        }
        nextAuthCheck = now + 15_000;
      }
      if (shutdown.signal.aborted) break;
      const job = store.claim(Date.now(), leaseDuration, nextCloudAt);
      if (job) {
        await processJob(store, job, shutdown.signal);
        if (job.cloud) nextCloudAt = Date.now() + cloudInterval;
      } else {
        const workout = store.nextDeviceBackfill(Date.now());
        if (workout) {
          const artifact = workout.artifact_id;
          const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]);
          const device = isId(artifact) ? await bridge<{ deviceModel: string | null }>(
            ['device-model', '--fit', join(artifactDirectory, artifact, 'source.fit')], signal,
          ).catch(() => null) : { deviceModel: null };
          if (!shutdown.signal.aborted) {
            if (device) store.finishDeviceBackfill(workout.id, artifact, device.deviceModel);
            else store.deferDeviceBackfill(workout.id, artifact, Date.now() + 60_000);
          }
          continue;
        }
        await pause(500, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    }
  } finally {
    channel.close();
    store.close();
  }
}

main().catch(() => {
  console.error('Could not start or maintain the Suunto worker.');
  process.exitCode = 1;
});
