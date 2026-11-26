import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as rawRequest } from 'node:http';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { corruptFit, fitActivity } from '../../tests/support/fit.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'suunto-web-test-'));
const project = 'suunto-web-test-' + randomBytes(4).toString('hex');
const override = join(temp, 'compose.json');
const uid = String(process.getuid()), gid = String(process.getgid());
const env = {
  ...process.env, SUUNTO_UID: uid, SUUNTO_GID: gid, SUUNTO_WEB_PORT: '0', SUUNTO_TIMEZONE: 'Europe/Warsaw',
  SUUNTO_WEB_AUTH_DIR: '/synthetic-auth-bind-must-not-be-mounted',
};
delete env.COMPOSE_ENV_FILES;
const volume = (source, target, readOnly = false) => ({
  type: 'volume', source, target, read_only: readOnly, volume: { nocopy: true },
});
const auth = [volume('smoke-config', '/auth-config', true), volume('smoke-auth', '/auth/.local')];
const cli = [volume('smoke-private', '/app/suunto-cloud/.local'), volume('smoke-reports', '/app/reports'),
  volume('smoke-charts', '/app/visualizations')];
const writable = [auth[1], ...cli];
writeFileSync(override, JSON.stringify({
  volumes: Object.fromEntries([...auth, ...cli].map(({ source }) => [source, {}])),
  services: {
    worker: { volumes: auth },
    suunto: { volumes: [...auth, ...cli] },
    'web-data-init': {
      volumes: writable.map(({ source }) => volume(source, '/' + source)),
      command: ['chmod 0700 /data /smoke-* && chown "$1:$2" /data /smoke-*', 'init', uid, gid],
    },
  },
}));

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '--env-file', devNull, '-f', 'compose.yaml',
    '-f', override, '-p', project, ...args], { cwd: repo, env, encoding: 'utf8', stdio: 'inherit', ...options });
}

function execute(service, args, input = '') {
  return compose(['exec', '-T', service, ...args], { input, stdio: ['pipe', 'pipe', 'inherit'] });
}

let base;
function address() {
  return 'http://' + compose(['port', 'web', '3000'], { stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

async function request(path, { method = 'GET', body, expected = 200, extra = {}, authorized = true } = {}) {
  const headers = { ...extra };
  if (authorized && method !== 'GET') Object.assign(headers, { 'X-Suunto-Request': '1', Origin: base });
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] ??= 'application/json';
    body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(base + path, { method, body, headers, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNRESET' || error.cause?.code === 'UND_ERR_SOCKET') return null;
    throw error;
  }
  assert.equal(response.status, expected, path);
  const type = response.headers.get('content-type') ?? '';
  return {
    headers: response.headers,
    data: type.startsWith('application/json') ? await response.json() : await response.text(),
  };
}
async function data(path, settings) { return (await request(path, settings))?.data; }

async function eventually(check, timeout = 35000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the web application.');
    await sleep(400);
  }
}

async function readyWorkout(total) {
  const library = await data('/api/workouts?limit=2');
  if (!library) return null;
  const failed = library.workouts.find(entry => entry.status === 'failed');
  assert.equal(failed, undefined, 'A synthetic FIT failed.');
  return library.total === total && library.workouts.every(entry => entry.status === 'ready') ? library.workouts[0] : null;
}

async function upload(bytes) {
  const body = new FormData();
  body.append('files', new Blob([bytes]), 'synthetic.fit');
  return (await data('/api/import', { method: 'POST', body, expected: 202 })).files[0];
}

function verifyDeviceModels() {
  const named = fitActivity({ deviceModel: ' Suunto Race 2 ' });
  const fixtures = {
    name: [named, 'Suunto Race 2'], known: [fitActivity({ product: 67 }), 'Suunto Vertical 2'],
    unknown: [fitActivity({ product: 65534 }), null], missing: [null, null], invalid: [corruptFit(named), null],
  };
  const inputs = Object.fromEntries(Object.entries(fixtures).map(([key, [fit, model]]) =>
    [key, [fit?.toString('base64') ?? null, model]]));
  execute('worker', ['node', '--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
for (const [name, [fit, model]] of Object.entries(JSON.parse(readFileSync(0, 'utf8')))) {
  const folder = mkdtempSync(join(tmpdir(), 'suunto-synthetic-'));
  try {
    const path = join(folder, 'synthetic.fit');
    if (fit !== null) writeFileSync(path, Buffer.from(fit, 'base64'));
    const result = spawnSync(process.execPath, ['suunto_cloud/web_bridge.mjs', 'device-model', '--fit', path],
                             { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, name === 'invalid' ? 1 : 0, name);
    assert.deepEqual(JSON.parse(result.stdout), name === 'invalid' ? {
      error: { code: 'ANALYSIS_FAILED', message: 'The workout operation could not be completed.' },
    } : { deviceModel: model }, name);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
`], JSON.stringify(inputs));
}

async function verifySettings() {
  assert.equal(await eventually(async () => (await data('/api/status'))?.timeZone), 'Europe/Warsaw');
  assert.equal((await data('/api/status')).interpretationAvailable, false);
  assert.equal((await data('/api/workouts')).total, 0);
  assert.match(await data('/'), /<html lang="en"/);
  const status = await new Promise((resolve, reject) => {
    const outgoing = rawRequest(base + '/api/status', { headers: { Host: 'unrelated.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal(status, 403);
  await request('/api/sync', { method: 'POST', authorized: false, expected: 403 });
  await request('/api/sync', { method: 'POST', authorized: false, expected: 403,
    extra: { 'X-Suunto-Request': '1', Origin: 'http://unrelated.example' } });
  const settingsPath = '/api/suunto/settings';
  const empty = { clientId: null, redirectUri: 'http://127.0.0.1:8765/callback',
    clientSecretSaved: false, subscriptionKeySaved: false };
  assert.deepEqual(await data(settingsPath), empty);
  const synthetic = {
    clientId: 'SYNTHETIC_CLIENT_ID', clientSecret: 'SYNTHETIC_CLIENT_SECRET', subscriptionKey: 'SYNTHETIC_SUBSCRIPTION_KEY',
  };
  const settings = { ...empty, clientId: synthetic.clientId, clientSecretSaved: true, subscriptionKeySaved: true };
  await request(settingsPath, { method: 'POST', body: synthetic, expected: 403, authorized: false });
  const saved = await request(settingsPath, { method: 'POST', body: synthetic });
  assert.deepEqual(saved.data, settings);
  assert.match(saved.headers.get('cache-control'), /no-store/);
  execute('worker', ['sh', '-ec', 'test "$(stat -c %a /auth/.local/credentials.json)" = 600']);
  assert.deepEqual(await data(settingsPath, { method: 'POST', body: {
    ...synthetic, clientSecret: '', subscriptionKey: 'SYNTHETIC_REPLACEMENT_KEY',
  } }), settings);
  execute('worker', ['node', '--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { loadCredentials } from './suunto_cloud/authentication/access.mjs';
const credentials = await loadCredentials();
assert.equal(credentials.client_secret, 'SYNTHETIC_CLIENT_SECRET');
assert.equal(credentials.subscription_key, 'SYNTHETIC_REPLACEMENT_KEY');
`]);
  const providers = { openai: 'openai-api-key', claude: 'anthropic-api-key' };
  const availability = { openai: false, claude: false };
  for (const [provider, filename] of Object.entries(providers)) {
    const path = '/api/' + provider + '/settings';
    assert.deepEqual(await data(path), { configured: false, editable: true });
    const body = { apiKey: `SYNTHETIC_${provider.toUpperCase()}_KEY` };
    await request(path, { method: 'POST', body, expected: 403, authorized: false });
    await request(path, { method: 'POST', body: { apiKey: 'bad key' }, expected: 400 });
    const result = await request(path, { method: 'POST', body });
    assert.deepEqual(result.data, { configured: true, editable: true });
    assert.match(result.headers.get('cache-control'), /no-store/);
    availability[provider] = true;
    assert.deepEqual((await data('/api/status')).interpretationAvailability, availability);
    execute('worker', ['sh', '-ec', `test "$(stat -c %a /auth/.local/${filename})" = 600`]);
  }
  return { settingsPath, settings, providers, availability };
}

async function verifyFitImport(bytes) {
  assert.equal((await upload(bytes)).status, 'queued');
  const workout = await eventually(() => readyWorkout(1));
  const path = '/api/workouts/' + workout.id;
  const { data: details, headers } = await request(path);
  assert.equal(details.source, 'fit');
  assert.equal(details.interpretation, null);
  assert.deepEqual(details.interpretations, { openai: { result: null }, claude: { result: null } });
  assert.match(headers.get('cache-control'), /no-store/);
  await request(path + '/interpret?provider=unknown', { method: 'POST', body: {}, expected: 400 });
  const chart = await request(path + '/chart');
  assert.match(chart.headers.get('content-security-policy'), /sandbox/);
  assert.match(chart.data, /⌚<\/tspan> Suunto Race 2<\/text>/);
  const baseline = JSON.parse(readFileSync(join(repo, 'tests/baselines/web-fit-import-v1.4.0.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.keys(baseline.workout).map(key => [key, details[key]])), baseline.workout);
  const payload = chart.data.split('<script id="chart-data" type="application/json">')[1].split('</script>')[0];
  assert.deepEqual(JSON.parse(payload), baseline.chartData);
  const polish = await data(path + '/chart?lang=pl');
  assert.match(polish, /Czas aktywny/);
  assert.match(polish, /Przypnij pozycję/);
  for (const language of ['en', 'pl']) {
    const embedded = await request(path + '/chart?embed=1&lang=' + language);
    assert.equal(embedded.headers.get('content-language'), language);
    assert.match(embedded.data, /suunto-chart-height/);
    assert.match(embedded.data, /suunto-chart-cursor/);
    assert.match(embedded.data, /main > \.help \{ display: none; \}/);
  }
  assert.doesNotMatch(chart.data, /suunto-chart-height|suunto-chart-cursor/);
  const preview = await data(path + '/route');
  const route = await request(path + '/route?view=map');
  assert.match(route.headers.get('cache-control'), /no-store/);
  assert.deepEqual(route.data.segments[0].map(point => point[2]), Array.from({ length: 61 }, (_, second) => second));
  assert.equal(preview.segments[0].length, route.data.segments[0].length);
  assert(preview.segments[0].every(point => point.length === 2));
  assert.match(await data('/workouts/' + workout.id), /<html lang="en"/);
  await request(path + '/source.fit', { expected: 404 });
  assert.equal((await upload(bytes)).status, 'duplicate');
  assert.equal((await data('/api/workouts')).total, 1);
  return { workout, path, details, chart: chart.data };
}

async function verifyBackfill({ workout, path, details, chart }, result, options) {
  compose(['stop', 'worker']);
  execute('web', ['node', '--input-type=module', '-e', `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/data/library.sqlite', { timeout: 3000 });
db.prepare('UPDATE workouts SET device_model = NULL, device_retry_at = 0 WHERE id = ?').run(process.argv[1]);
db.close();
`, workout.id]);
  assert.equal((await data(path)).deviceModel, null);
  compose(['down']);
  compose(['up', '-d', 'web', 'worker']);
  base = address();
  assert.equal((await eventually(() => readyWorkout(1))).id, workout.id);
  assert(await eventually(async () => (await data(path)).deviceModel === details.deviceModel));
  assert.equal((await data(path)).analysisVersion, details.analysisVersion);
  assert.deepEqual((await data('/api/status')).lastSyncResult, result);
  assert.deepEqual(await data(options.settingsPath), options.settings);
  for (const provider of Object.keys(options.providers)) {
    assert.deepEqual(await data('/api/' + provider + '/settings'), { configured: true, editable: true });
  }
  assert.equal(await data(path + '/chart'), chart);
  await request(path + '/retry', { method: 'POST', body: {}, expected: 202 });
  assert(await eventually(async () => (await data(path)).analysisVersion > details.analysisVersion));
}

async function verifyErrors(bytes, original, resultPath, providers) {
  assert.equal((await upload(fitActivity({ start: 1_000_100_000 }))).status, 'queued');
  const indoor = await eventually(() => readyWorkout(2));
  assert.notEqual(indoor.id, original.workout.id);
  assert.deepEqual(await data('/api/workouts/' + indoor.id + '/route?view=map'), { segments: null });
  const invalid = await upload(corruptFit(bytes));
  assert.equal(invalid.status, 'queued');
  const invalidPath = '/api/workouts/' + invalid.id;
  assert(await eventually(async () => (await data(invalidPath)).status === 'failed'));
  assert.equal(await data(original.path + '/chart'), original.chart);
  const path = '/api/jobs/errors';
  const errors = (await data(path)).errors;
  assert.deepEqual(errors.map(job => job.kind), ['analyze', 'sync']);
  assert.equal(errors[0].workoutId, invalid.id);
  assert(errors[0].error);
  assert.equal((await data('/api/status')).jobs.failed, 2);
  await request(path, { method: 'DELETE', expected: 403, authorized: false });
  await request(path + '/' + errors[1].id, { method: 'DELETE', expected: 204 });
  assert.deepEqual((await data(path)).errors.map(job => job.kind), ['analyze']);
  assert.equal((await data('/api/status')).jobs.failed, 1);
  await request(path, { method: 'DELETE', expected: 204 });
  assert.deepEqual(await data(path), { errors: [] });
  assert.equal((await data('/api/status')).jobs.failed, 0);
  assert.equal((await data(invalidPath)).status, 'failed');
  assert.equal((await data(resultPath)).status, 'failed');
  for (const [provider, filename] of Object.entries(providers)) {
    const path = '/api/' + provider + '/settings';
    await request(path, { method: 'DELETE', expected: 403, authorized: false });
    assert.deepEqual(await data(path, { method: 'DELETE' }), { configured: false, editable: true });
    execute('worker', ['sh', '-ec', `test ! -e /auth/.local/${filename}`]);
  }
}

function verifyCli(bytes) {
  const run = (args, input = '', entrypoint) => compose([
    '--profile', 'cli', 'run', '--rm', '-T', '--no-deps',
    ...(entrypoint ? ['--entrypoint', entrypoint] : []), 'suunto', ...args,
  ], { input, stdio: ['pipe', 'pipe', 'inherit'] });
  run(['-ec', '! command -v python3 && ! command -v python && test -z "$(find /app -type f -name \'*.py\')"'], '', 'sh');
  const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(run(['--version']).trim(), `suunto-cloud ${version}`);
  const fixture = '/app/suunto-cloud/.local/synthetic.fit';
  run(['-e', "require('node:fs').writeFileSync(process.argv[1], require('node:fs').readFileSync(0), {mode: 0o600})", fixture], bytes, 'node');
  const outputs = JSON.parse(run(['import-fit', fixture, '--charts']));
  const read = path => run(['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", path], '', 'node');
  const report = JSON.parse(read(outputs.json_path));
  assert.equal(report.cloud.distance_m, 180);
  assert.equal(report.fit.active_hr_sample_count, 60);
  assert.equal(report.source.source_type, 'local_fit');
  assert.equal(report.chart_path, outputs.chart_path);
  assert.match(read(outputs.markdown_path), /Imported from local FIT:/);
  assert.match(read(outputs.svg_path), /data-metric="heart-rate"/);
  assert.match(read(outputs.chart_path), /class="workout-summary"/);
  assert.match(run(['track', '--input', fixture]), /GPS points: 61; segments: 1\./);
  run(['-e', "require('node:fs').appendFileSync(process.argv[1], '\\nSynthetic personal note.\\n')", outputs.markdown_path], '', 'node');
  const saved = JSON.parse(run(['charts', outputs.json_path, '--hr-range', '110', '175']));
  assert.deepEqual(saved, outputs);
  assert.match(read(outputs.markdown_path), /Synthetic personal note\./);
  const chart = read(outputs.chart_path);
  const payload = JSON.parse(chart.split('<script id="chart-data" type="application/json">')[1].split('</script>')[0]);
  assert.deepEqual([payload.panels[0].lo, payload.panels[0].hi], [110, 175]);
  const synchronized = JSON.parse(run(['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { main } from './suunto_cloud/cli.mjs';
const directory = '/app/suunto-cloud/.local';
process.env.SUUNTO_AUTH_DIR = directory;
process.env.SUUNTO_CONFIG_PATH = directory + '/config.json';
const client = 'synthetic-cli-client';
await writeFile(process.env.SUUNTO_CONFIG_PATH, JSON.stringify({ client_id: client }), {mode: 0o600});
await writeFile(directory + '/credentials.json', JSON.stringify({
  client_id: client, client_secret: 'synthetic-cli-secret', subscription_key: 'synthetic-cli-key',
}), {mode: 0o600});
await writeFile(directory + '/tokens.json', JSON.stringify({
  client_id: client, access_token: 'synthetic-old-token', refresh_token: 'synthetic-refresh',
  received_at_unix: Math.floor(Date.now() / 1000), expires_in: 3600, authorization_id: 'synthetic-signin',
}), {mode: 0o600});
const fit = await readFile(directory + '/synthetic.fit');
const key = '2'.repeat(24);
const start = Date.parse('2021-09-08T01:46:40Z');
let pages = 0, refreshes = 0, downloads = 0;
globalThis.fetch = async (url, options) => {
  assert.equal(options.redirect, 'manual');
  const { pathname } = new URL(url);
  if (pathname === '/oauth/token') {
    assert.equal(options.body.get('refresh_token'), 'synthetic-refresh');
    refreshes++;
    return Response.json({ access_token: 'synthetic-new-token', expires_in: 3600 });
  }
  assert.equal(options.headers['Ocp-Apim-Subscription-Key'], 'synthetic-cli-key');
  if (pathname === '/v2/workouts' && ++pages === 1) {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-old-token');
    return new Response('Expired access token', {status: 401});
  }
  assert.equal(options.headers.Authorization, 'Bearer synthetic-new-token');
  if (pathname === '/v2/workouts') return Response.json({ payload: [{
    workoutKey: key, activityId: 1, startTime: start, stopTime: start + 60000, lastModified: start,
    totalDistance: 180, totalTime: 60, hrdata: {workoutAvgHR: 134, workoutMaxHR: 139},
  }] });
  assert.equal(pathname, '/v3/workouts/' + key + '/fit');
  downloads++;
  return new Response(fit);
};
assert.equal(await main(['sync', '--date', '2021-09-08', '--analysis', '--brief', '--charts']), 0);
assert.deepEqual([pages, refreshes, downloads], [2, 1, 1]);
const saved = JSON.parse(await readFile(directory + '/tokens.json', 'utf8'));
assert.equal(saved.authorization_id, 'synthetic-signin');
assert.equal(saved.refresh_token, 'synthetic-refresh');
`], '', 'node'));
  assert.equal(synchronized.complete, true);
  assert.equal(synchronized.workouts.length, 1);
  assert.equal(synchronized.workouts[0].cloud.distance_m, 180);
  assert.match(read(synchronized.workouts[0].outputs.svg_path), /data-metric="heart-rate"/);
}

try {
  const configuration = JSON.parse(compose(['--profile', 'cli', 'config', '--format', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] }));
  for (const service of ['suunto', 'worker']) {
    const mounts = new Map(configuration.services[service].volumes.map(mount => [mount.target, mount]));
    for (const expected of service === 'suunto' ? [...auth, ...cli] : auth) {
      assert.equal(mounts.get(expected.target).type, 'volume');
      assert.equal(mounts.get(expected.target).source, expected.source);
    }
  }
  compose(['up', '-d', '--build', 'web', 'worker']);
  for (const service of ['web', 'worker']) execute(service, ['sh', '-ec',
    '! command -v python3 && ! command -v python && test -z "$(find /app -type f -name \'*.py\')"']);
  execute('worker', ['node', '--input-type=module', '-'], readFileSync(join(repo, 'scripts/docker/test-web-state.mjs'), 'utf8'));
  verifyDeviceModels();
  base = address();
  const settings = await verifySettings();
  const sync = await data('/api/sync', { method: 'POST', body: {}, expected: 202 });
  const resultPath = '/api/sync/' + sync.jobId;
  const result = await eventually(async () => {
    const state = await data(resultPath);
    return state?.status === 'failed' ? state : null;
  });
  assert(result.error);
  assert.equal(result.added + result.updated + result.failed, 0);
  assert.deepEqual((await data('/api/status')).lastSyncResult, result);
  const bytes = fitActivity({ deviceModel: 'Suunto Race 2', gps: true });
  const imported = await verifyFitImport(bytes);
  execute('web', ['sh', '-ec', 'test ! -e /auth && test "$(stat -c %a /data/library.sqlite)" = 600']);
  await verifyBackfill(imported, result, settings);
  await verifyErrors(bytes, imported, resultPath, settings.providers);
  compose(['--profile', 'cli', 'build', 'suunto']);
  verifyCli(bytes);
  console.log('Compose smoke test passed: Node-only images, web imports, privacy, CLI reports and simulated Suunto sync.');
} finally {
  compose(['down', '-v']);
  rmSync(temp, { recursive: true, force: true });
}
