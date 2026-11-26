#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { summarizeFit } from './analysis/fit.mjs';
import { AccessError, authorizedCall, getAccessToken, isCurrent, loadConfig, loadCredentials, loadTokens, safeError, saveTokens } from './authentication/access.mjs';
import { TokenExchangeError, authorize } from './authentication/oauth.mjs';
import { chooseWorkout, dateCutoff, fetchFit, fetchWorkouts, paginatedWorkouts, workoutRecords } from './downloads/cloud.mjs';
import { HttpError, limitedBody, NetworkError } from './downloads/http.mjs';
import gpx from './fit/export_gpx.cjs';
import { importFit } from './fit/import.mjs';
import { fixed } from './reporting/format.mjs';
import { regenerateReport } from './reporting/reports.mjs';
import { cloudArtifactStem, privateDirectory, privateJson, privateWrite, readConfig, userTimezone, withAuthenticationLock } from './storage/local.mjs';
import { sync } from './synchronization/service.mjs';
import { localTimestamp } from './timezones.mjs';

const usage = {
  sync: '--date DATE [--date DATE] [--configure] [--no-decode] [--analysis] [--brief] [--charts] [--sleep-data PATH]',
  oauth: '[--settings] [--prompt-secret]',
  access: '[--configure] [--refresh]',
  workouts: '[--since DATE | --all]',
  track: '[--date DATE | --workout-key KEY | --input FILE] [--fit-only]',
  analyze: 'INPUT',
  'import-fit': 'INPUT [--charts]',
  charts: 'REPORT [--hr-range MIN MAX] [--sleep-data PATH]',
};
const descriptions = {
  sync: 'Download and analyze workouts', oauth: 'Authorize a Suunto account',
  access: 'Configure credentials and check access', workouts: 'Download the workout list',
  track: 'Download FIT or export GPX', analyze: 'Analyze decoded FIT data',
  'import-fit': 'Analyze a local FIT file offline', charts: 'Generate charts from a saved report',
};
const options = {
  sync: { date: { type: 'string', multiple: true }, configure: { type: 'boolean' }, 'no-decode': { type: 'boolean' },
    analysis: { type: 'boolean' }, brief: { type: 'boolean' }, charts: { type: 'boolean' }, 'sleep-data': { type: 'string' } },
  oauth: { settings: { type: 'boolean' }, 'prompt-secret': { type: 'boolean' } },
  access: { configure: { type: 'boolean' }, refresh: { type: 'boolean' } },
  workouts: { since: { type: 'string' }, all: { type: 'boolean' } },
  track: { date: { type: 'string' }, 'workout-key': { type: 'string' }, input: { type: 'string' }, 'fit-only': { type: 'boolean' } },
  analyze: {}, 'import-fit': { charts: { type: 'boolean' } },
  charts: { 'hr-range': { type: 'string' }, 'sleep-data': { type: 'string' } },
};
const expectsInput = new Set(['analyze', 'import-fit', 'charts']);
class UsageError extends Error {}

function printUsage(command, stream = process.stdout) {
  stream.write(`usage: suunto-cloud ${command ? command + ' [-h] ' + usage[command] :
    '[-h] [--version] {sync,oauth,access,workouts,track,analyze,import-fit,charts}'}\n`);
}

function validDate(day) {
  const date = new Date(day + 'T00:00:00Z');
  return /^\d{4}-\d\d-\d\d$/.test(day) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function parseCommand(command, args) {
  const prepared = [...args];
  const at = command === 'charts' ? prepared.indexOf('--hr-range') : -1;
  if (at >= 0) {
    const [low, high] = prepared.slice(at + 1, at + 3);
    if (!low || !high || low.startsWith('--') || high.startsWith('--')) throw new UsageError('--hr-range requires MIN and MAX.');
    prepared.splice(at, 3, `--hr-range=${low},${high}`);
  }
  const { values, positionals } = parseArgs({ args: prepared, options: options[command], allowPositionals: true });
  if (positionals.length !== Number(expectsInput.has(command))) throw new UsageError('Check the required file argument.');
  if (command === 'sync' && !values.date?.length) throw new UsageError('The --date argument is required.');
  const dates = values.date ? [].concat(values.date) : values.since === undefined ? [] : [values.since];
  if (dates.some(day => !validDate(day))) throw new UsageError('Use a valid date in YYYY-MM-DD format.');
  if (command === 'track' && [values.date, values['workout-key'], values.input].filter(value => value !== undefined).length > 1) {
    throw new UsageError('--date, --workout-key and --input are mutually exclusive.');
  }
  if (command === 'workouts' && values.since && values.all) throw new UsageError('--since and --all are mutually exclusive.');
  let hrRange = null;
  if (values['hr-range'] !== undefined) {
    hrRange = values['hr-range'].split(',').map(Number);
    if (hrRange.length !== 2 || !hrRange.every(Number.isFinite) || hrRange[0] < 0 || hrRange[0] >= hrRange[1]) {
      throw new UsageError('--hr-range requires finite limits with 0 <= MIN < MAX.');
    }
  }
  return { values, input: positionals[0], hrRange };
}

async function hiddenInput(questions, signal) {
  if (!process.stdin.isTTY) throw new AccessError('Run configuration in your interactive terminal; do not pass credentials as arguments.');
  const tty = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' });
  const state = tty.stdout?.trim();
  if (tty.status !== 0 || !state || spawnSync('stty', ['-echo'], { stdio: 'inherit' }).status !== 0) {
    throw new AccessError('Could not disable terminal echo.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    const answers = [];
    for (const prompt of questions) {
      answers.push(await terminal.question(prompt, { signal }));
      process.stderr.write('\n');
    }
    return answers;
  } finally {
    terminal.close();
    spawnSync('stty', [state], { stdio: 'inherit' });
  }
}

async function configure(signal) {
  const config = await loadConfig();
  if (!process.stdin.isTTY) throw new AccessError('Run configuration in your interactive terminal; do not pass credentials as arguments.');
  console.log('One-time Suunto setup. Credential input is hidden.');
  console.log('Get the client secret and Primary/Secondary Key from https://apizone.suunto.com/profile');
  const [secret, subscription] = (await hiddenInput(['Client secret from OAuth application settings: ',
    'Primary or Secondary Key from the Developer API subscription: '], signal)).map(value => value.trim());
  if (!secret || !subscription) throw new AccessError('Both credentials are required; the configuration file was not changed.');
  await withAuthenticationLock(() => saveTokens({
    client_id: config.client_id, client_secret: secret, subscription_key: subscription,
  }, 'credentials.json'));
  console.log('Credentials saved to .local/credentials.json (0600, directory 0700, excluded from Git).');
  console.log('This confirms local storage. The sync command checks connectivity and credential validity.');
}

async function access(values, signal) {
  if (values.configure) await configure(signal);
  if (values.refresh) {
    await getAccessToken(true);
    console.log('OAuth refresh completed and saved locally.');
  }
  const credentials = await loadCredentials();
  const tokens = await loadTokens();
  console.log(JSON.stringify({
    client_secret_saved_or_in_environment: Boolean(credentials.client_secret),
    subscription_key_saved_or_in_environment: Boolean(credentials.subscription_key),
    access_token_current: isCurrent(tokens), refresh_token_present: Boolean(tokens.refresh_token), network_checked: false,
  }, null, 2));
}

async function list(values) {
  const cutoff = values.since ? dateCutoff(values.since, await userTimezone()) : null;
  const get = query => authorizedCall((token, subscription) => fetchWorkouts(token, subscription, query));
  const data = values.all || cutoff !== null ? await paginatedWorkouts(get, cutoff) : await get({});
  if (cutoff !== null) {
    if (!data.payload.every(row => Number.isSafeInteger(row.startTime))) throw new TypeError('Unexpected Cloud API workout start times.');
    data.payload = data.payload.filter(row => row.startTime >= cutoff);
    data.metadata.workoutcount = String(data.payload.length);
  }
  const records = workoutRecords(data);
  const path = await privateJson(join(await privateDirectory(), 'workouts.json'), data);
  console.log(`HTTP 200 — Cloud API read succeeded. Data saved to: ${path}`);
  console.log(`Records in this response: ${records.length}`);
  console.log(`Workout list pages read: ${data.metadata?.pages ?? 1}`);
}

async function track(values) {
  const directory = await privateDirectory();
  const tracks = join(directory, 'tracks');
  let path, name;
  if (values.input) {
    path = await realpath(values.input);
    name = basename(path, extname(path));
    await mkdir(tracks, { recursive: true, mode: 0o700 });
  } else {
    const zone = await userTimezone();
    const records = workoutRecords(JSON.parse(await readFile(join(directory, 'workouts.json'), 'utf8')));
    const workout = chooseWorkout(records, values.date, values['workout-key'], zone);
    const started = localTimestamp(workout.startTime, zone);
    name = cloudArtifactStem(started, workout.workoutKey);
    path = join(tracks, name + '.fit');
    console.log(`Downloading workout FIT: ${started}, ${fixed((workout.totalDistance ?? 0) / 1000, 3)} km...`);
    await privateWrite(path, await authorizedCall((token, key) => fetchFit(workout.workoutKey, token, key)));
    console.log(`FIT saved to: ${path}`);
  }
  if (!values['fit-only']) {
    const destination = join(tracks, name + '.gpx');
    let result;
    try {
      result = await gpx.convert(path, destination);
    } catch {
      throw new AccessError(`GPX conversion failed. The original FIT is saved at ${path}.`);
    }
    console.log(`GPX saved to: ${destination}\nGPS points: ${result.gps_point_count}; segments: ${result.segment_count}.`);
  }
}

async function commandError(command, error) {
  if (error instanceof HttpError && (command === 'track' || command === 'workouts')) {
    const body = (await limitedBody(error.response, 4096)).toString('utf8').toLowerCase();
    if (command === 'track') {
      let hint = 'Check token validity and the Developer API subscription.';
      if (body.includes('operationnotfound') || error.status === 404) {
        hint = 'The FIT v3 endpoint is unavailable. Use the Request URL for export-workout-fit from API Zone.';
      } else if (body.includes('ratelimitexceeded') || error.status === 429) hint = 'API rate limit reached. Try again later.';
      return `FIT download: HTTP ${error.status}. ${hint}`;
    }
    let hint = '';
    if (body.includes('invalid subscription key') || body.includes('missing subscription key')) {
      hint = ' Check the Primary/Secondary Key and whether the Developer API subscription is active.';
    } else if (error.status === 401) hint = ' API authentication was rejected. Check token validity and the subscription key.';
    else if (error.status === 403) hint = ' Check application permissions and the Developer API subscription.';
    else if (error.status === 429) hint = ' Developer API rate limit reached; try again later.';
    return `Cloud API returned HTTP ${error.status}.${hint}`;
  }
  if (command === 'oauth') {
    if (error instanceof TokenExchangeError) return error.message;
    return error instanceof SyntaxError ? 'Error: Invalid Suunto JSON.' : `Error: ${error.message}`;
  }
  if (command === 'import-fit') {
    return `FIT import failed: ${error instanceof SyntaxError ? 'Invalid Suunto JSON.' : error.message}`;
  }
  if (command === 'analyze' || command === 'charts') {
    const label = command === 'analyze' ? 'Analysis' : 'Chart generation';
    return error instanceof RangeError && command === 'analyze' ? error.message : `${label} failed (${error.name}).`;
  }
  return safeError(error);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === '--version') {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(`suunto-cloud ${version}`);
    return 0;
  }
  if (command === '-h' || command === '--help') {
    printUsage();
    for (const [name, description] of Object.entries(descriptions)) console.log(`  ${name.padEnd(12)}${description}`);
    return 0;
  }
  if (!Object.hasOwn(usage, command ?? '')) {
    printUsage(null, process.stderr);
    console.error(command ? 'Unknown command.' : 'A command is required.');
    return 2;
  }
  if (args.includes('--help') || args.includes('-h')) {
    printUsage(command);
    console.log(descriptions[command]);
    return 0;
  }
  let parsed;
  try {
    parsed = parseCommand(command, args);
  } catch (error) {
    printUsage(command, process.stderr);
    console.error(error instanceof UsageError ? error.message : 'Check the command arguments.');
    return 2;
  }
  const { values, input, hrRange } = parsed;
  const interrupt = new AbortController();
  const abort = () => interrupt.abort();
  const interruptible = command === 'oauth' || (command === 'access' || command === 'sync') && values.configure;
  if (interruptible) process.once('SIGINT', abort);
  try {
    switch (command) {
      case 'access': await access(values, interrupt.signal); break;
      case 'oauth': {
        const config = await readConfig();
        if (values.settings) console.log(JSON.stringify(config, null, 2));
        else {
          const destination = await authorize(config, async prompt => (await hiddenInput([prompt], interrupt.signal))[0],
            values['prompt-secret'], interrupt.signal);
          console.log(`Authorization completed. Tokens saved locally: ${destination}`);
        }
        break;
      }
      case 'sync': {
        const zone = await userTimezone();
        if (values.configure) await configure(interrupt.signal);
        await sync(values.date, { decode: !values['no-decode'], analysis: values.analysis,
          brief: values.brief, charts: values.charts, zone, sleepData: values['sleep-data'] });
        break;
      }
      case 'workouts': await list(values); break;
      case 'track': await track(values); break;
      case 'analyze': {
        const decoded = JSON.parse(await readFile(input, 'utf8'));
        console.log(JSON.stringify(summarizeFit(decoded, await userTimezone()), null, 2));
        break;
      }
      case 'import-fit': console.log(JSON.stringify(await importFit(input, await userTimezone(), values.charts))); break;
      case 'charts': console.log(JSON.stringify(await regenerateReport(input, hrRange, values['sleep-data']))); break;
    }
    return 0;
  } catch (error) {
    if (interrupt.signal.aborted || error.name === 'AbortError') {
      console.error('\nInterrupted.');
      return 130;
    }
    const message = await commandError(command, error).catch(() => safeError(new NetworkError()));
    console.error(message);
    return 1;
  } finally {
    if (interruptible) process.removeListener('SIGINT', abort);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
