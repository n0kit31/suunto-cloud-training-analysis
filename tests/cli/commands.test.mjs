import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../suunto_cloud/cli.mjs', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', timeout: 10000, env: { ...process.env, SUUNTO_CONFIG_PATH: '/invalid/synthetic/path' },
});

test('CLI version and help work without private configuration', () => {
  assert.equal(run('--version').stdout.trim(), `suunto-cloud ${version}`);
  for (const command of ['sync', 'oauth', 'access', 'workouts', 'track', 'analyze', 'import-fit', 'charts']) {
    const result = run(command, '--help');
    assert.equal(result.status, 0, command);
    assert.match(result.stdout, /^usage:/, command);
  }
});

test('missing date or invalid chart limits fail before reading private files', () => {
  const missing = run('sync');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--date/);
  const limits = run('charts', '/nonexistent', '--hr-range', '125', '100');
  assert.equal(limits.status, 2);
  assert.match(limits.stderr, /--hr-range/);
});
