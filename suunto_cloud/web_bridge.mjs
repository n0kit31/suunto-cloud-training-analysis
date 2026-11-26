import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cloudMetrics } from './analysis/cloud_metrics.mjs';
import { AccessError, authorizedCall, isCurrent, loadCredentials, loadTokens } from './authentication/access.mjs';
import { InvalidSettings, readSettings, saveSettings } from './authentication/web_settings.mjs';
import { chooseWorkout, dateCutoff, fetchFit, fetchWorkouts, paginatedWorkouts } from './downloads/cloud.mjs';
import { HttpError, NetworkError } from './downloads/http.mjs';
import devices from './fit/device_model.cjs';
import { authenticationDirectory, isObject, userTimezone } from './storage/local.mjs';
import { localTimestamp } from './timezones.mjs';
import { AnalysisError, analyzeFit, readFit, summaryFields } from './web_analysis.mjs';

const webTimezone = async () => await userTimezone() || 'UTC';
const error = (code, message, retryAfterMs) => ({ error: { code, message, retryAfterMs } });

function retryDelay(header) {
  if (!header) return undefined;
  if (/^\d{1,9}$/.test(header)) return Number(header) * 1000;
  const date = /[a-z]{3}/i.test(header) ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function apiError(status, retryAfter, fitDownload) {
  if (status === 429) return error('RATE_LIMIT', 'Suunto rate limit reached. Try again later.', retryDelay(retryAfter));
  if (status === 401 || status === 403) return error('AUTH_REQUIRED', 'Suunto authorization or the API subscription needs attention.');
  if (fitDownload && (status === 404 || status === 410)) return error('FIT_UNAVAILABLE', 'A FIT file is unavailable for this activity.');
  if (status === 408 || status >= 500) return error('NETWORK', 'Suunto is temporarily unavailable.');
  return error('ANALYSIS_FAILED', 'Suunto rejected the request.');
}

async function authorizationRevision() {
  let credentials, tokens;
  try {
    credentials = await loadCredentials();
    tokens = await loadTokens();
  } catch (error) {
    if (error instanceof AccessError || error instanceof SyntaxError || error instanceof TypeError || error.code) return null;
    throw error;
  }
  const refresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token && credentials.client_secret;
  if (!credentials.subscription_key?.trim() || !(isCurrent(tokens) || refresh)) return null;
  const file = await stat(join(await authenticationDirectory(), 'credentials.json'), { bigint: true, throwIfNoEntry: false });
  // Keep the existing authorization fingerprint on upgrade. The old
  // serialization used ASCII JSON and exact integer file metadata.
  const text = value => JSON.stringify(value).replace(/[^\x00-\x7e]/g, unit =>
    '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0'));
  const fileRevision = file ? `[${file.mtimeNs}, ${file.ino}]` : 'null';
  const revision = `[${text(credentials.client_id)}, ${fileRevision}, ${text(tokens.authorization_id ?? null)}]`;
  return createHash('sha256').update(revision).digest('hex');
}

export async function listWorkouts({ sinceDays, modifiedSince }, now = Date.now(), pageLoader) {
  const zone = await webTimezone();
  let cutoff = modifiedSince;
  if (sinceDays !== undefined) {
    const local = localTimestamp(now, zone).slice(0, 10);
    const day = new Date(Date.parse(local + 'T00:00:00Z') - (sinceDays - 1) * 86400000).toISOString().slice(0, 10);
    cutoff = dateCutoff(day, zone);
  }
  const interval = Number(process.env.SUUNTO_REQUEST_INTERVAL_MS ?? 6500);
  let nextRequest = 0;
  const pacedFetch = query => authorizedCall(async (token, subscription) => {
    const delay = nextRequest - performance.now();
    if (delay > 0) await sleep(Math.ceil(delay));
    nextRequest = performance.now() + interval;
    return fetchWorkouts(token, subscription, query);
  });
  const { payload } = await paginatedWorkouts(pageLoader ?? pacedFetch, cutoff);
  const workouts = [];
  let latest = null;
  for (const record of payload) {
    const started = record.startTime;
    let modified = record.lastModified;
    if (!Number.isSafeInteger(started) || (sinceDays === undefined && !Number.isSafeInteger(modified))) {
      throw new TypeError('Invalid Suunto workout timestamp.');
    }
    if (Number.isSafeInteger(modified) && modified >= 0) latest = latest === null ? modified : Math.max(latest, modified);
    else modified = null;
    const selected = sinceDays === undefined ? modified : started;
    if (selected === null || selected < cutoff) continue;
    chooseWorkout([record], null, record.workoutKey);
    workouts.push({ sourceKey: record.workoutKey, modifiedAt: modified, ...summaryFields(cloudMetrics(record, zone)), cloud: record });
  }
  const high = latest !== null ? Math.min(now, latest) : payload.length ? cutoff : now;
  return { workouts, highWatermark: Math.max(0, cutoff, high), timeZone: zone };
}

async function analyze(workspace, cloudPath, fitPath) {
  if (!isAbsolute(workspace ?? '') || (!cloudPath && !fitPath)) {
    throw new AnalysisError('ANALYSIS_FAILED', 'A private workspace and a workout source are required.');
  }
  const zone = await webTimezone();
  let cloud = null;
  if (cloudPath) {
    cloud = JSON.parse(await readFile(cloudPath, 'utf8'));
    if (!isObject(cloud)) throw new TypeError('Cloud workout must be a record.');
    chooseWorkout([cloud], null, cloud.workoutKey);
  }
  const content = fitPath ? await readFit(fitPath) : await authorizedCall(async (token, key) => {
    try {
      return await fetchFit(cloud.workoutKey, token, key);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new AnalysisError('FIT_UNAVAILABLE', 'Suunto did not return a usable FIT file.');
      }
      throw error;
    }
  });
  return analyzeFit(workspace, content, zone, cloud, !fitPath);
}

async function run(command, options, readInput) {
  switch (command) {
    case 'list': {
      const sinceDays = options['since-days'] === undefined ? undefined : Number(options['since-days']);
      const modifiedSince = options['modified-since'] === undefined ? undefined : Number(options['modified-since']);
      if (sinceDays === undefined ? !Number.isSafeInteger(modifiedSince) || modifiedSince < 0 :
        modifiedSince !== undefined || !Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 366) {
        throw new AnalysisError('ANALYSIS_FAILED', 'The modification cutoff must be nonnegative.');
      }
      return listWorkouts({ sinceDays, modifiedSince });
    }
    case 'analyze': return analyze(options.workspace, options.cloud, options.fit);
    case 'device-model': return { deviceModel: devices.readDeviceModel(options.fit) };
    case 'auth-status': {
      const revision = await authorizationRevision();
      return { authorized: revision !== null, revision, timeZone: await webTimezone() };
    }
    case 'settings-read': return readSettings();
    case 'settings-save': {
      let data;
      try {
        data = JSON.parse(await readInput());
      } catch {
        throw new InvalidSettings('Check the format of your Suunto credentials.');
      }
      return saveSettings(data);
    }
    default: throw new TypeError('Unknown worker command.');
  }
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 8192) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  let options = {};
  let result;
  try {
    options = parseArgs({ args, options: {
      'since-days': { type: 'string' }, 'modified-since': { type: 'string' },
      workspace: { type: 'string' }, cloud: { type: 'string' }, fit: { type: 'string' },
    } }).values;
    result = await run(command, options, readInput);
  } catch (caught) {
    if (caught instanceof AnalysisError) result = error(caught.code, caught.message);
    else if (caught instanceof HttpError) result = apiError(caught.status, caught.retryAfter, command === 'analyze' && !options.fit);
    else if (caught instanceof NetworkError) result = error('NETWORK', 'Could not reach Suunto.');
    else if (caught instanceof AccessError) result = error('AUTH_REQUIRED', 'Complete Suunto authorization and verify the API subscription.');
    else if (caught instanceof InvalidSettings) result = error('SETTINGS_INVALID', caught.message);
    else result = error('ANALYSIS_FAILED', 'The workout operation could not be completed.');
    process.exitCode = 1;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
