import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccessError, authorizedCall, getAccessToken, loadTokens } from '../../suunto_cloud/authentication/access.mjs';
import { completeAuthorization, exchangeCode, parseCallback } from '../../suunto_cloud/authentication/oauth.mjs';
import { readSettings, saveSettings } from '../../suunto_cloud/authentication/web_settings.mjs';
import { HttpError } from '../../suunto_cloud/downloads/http.mjs';

async function syntheticAuthorization() {
  const directory = await mkdtemp(join(tmpdir(), 'suunto-auth-test-'));
  const config = { client_id: 'synthetic-client', redirect_uri: 'http://127.0.0.1:8765/callback' };
  const configPath = join(directory, 'config.json');
  const env = {
    SUUNTO_CONFIG_PATH: configPath, SUUNTO_AUTH_DIR: directory,
    SUUNTO_CLIENT_SECRET: '', SUUNTO_SUBSCRIPTION_KEY: '',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const write = (path, data) => writeFile(join(directory, path), JSON.stringify(data), { mode: 0o600 });
  await write('config.json', config);
  await write('credentials.json', { ...config, client_secret: 'synthetic-secret', subscription_key: 'synthetic-key' });
  await write('tokens.json', { client_id: config.client_id, access_token: 'synthetic-old', refresh_token: 'synthetic-refresh',
    authorization_id: 'synthetic-signin', received_at_unix: 0, expires_in: 60 });
  return { directory, config, write, cleanup: async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  } };
}

test('OAuth callback accepts one code from the matching state and callback path', () => {
  assert.equal(parseCallback('/callback?state=current&code=synthetic', 'current', '/callback'), 'synthetic');
  assert.equal(parseCallback('/callback?state=current&error=denied', 'current', '/callback'), null);
  assert.throws(() => parseCallback('/callback?state=wrong&code=synthetic', 'current', '/callback'), /state/);
  assert.throws(() => parseCallback('/callback?state=current&code=a&code=b', 'current', '/callback'), /exactly one/);
  assert.throws(() => parseCallback('/wrong?state=current&code=synthetic', 'current', '/callback'), { status: 404 });
});

test('OAuth rejects failed exchanges without displaying the response or code', async () => {
  const config = { client_id: 'synthetic-client', redirect_uri: 'http://127.0.0.1:8765/callback' };
  await assert.rejects(exchangeCode(config, 'synthetic-secret', 'synthetic-code', async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body.get('code'), 'synthetic-code');
    return Response.json({ error: 'invalid_grant', detail: 'synthetic-private-response' }, { status: 400 });
  }), error => error.message.includes('invalid_grant') && !error.message.includes('synthetic'));
});

test('concurrent access refreshes a rejected token once and retains its refresh token and sign-in', {
  skip: process.platform !== 'linux' ? 'The production file-lock integration runs in Docker.' : false,
}, async context => {
  const fixture = await syntheticAuthorization();
  context.after(fixture.cleanup);
  let refreshes = 0;
  const fetcher = async (_url, init) => {
    refreshes++;
    assert.equal(init.body.get('refresh_token'), 'synthetic-refresh');
    return Response.json({ access_token: 'synthetic-new', expires_in: 3600 });
  };
  assert.deepEqual(await Promise.all([getAccessToken(false, null, fetcher), getAccessToken(false, null, fetcher)]),
    ['synthetic-new', 'synthetic-new']);
  assert.equal(refreshes, 1);
  const tokens = await loadTokens();
  assert.equal(tokens.refresh_token, 'synthetic-refresh');
  assert.equal(tokens.authorization_id, 'synthetic-signin');
  assert.equal((await stat(join(fixture.directory, 'tokens.json'))).mode & 0o777, 0o600);
});

test('a rejected Azure subscription does not cause OAuth refresh or an authenticated replay', {
  skip: process.platform !== 'linux' ? 'The production file-lock integration runs in Docker.' : false,
}, async context => {
  const fixture = await syntheticAuthorization();
  context.after(fixture.cleanup);
  await fixture.write('tokens.json', { client_id: fixture.config.client_id, access_token: 'synthetic-current',
    received_at_unix: Date.now() / 1000, expires_in: 3600 });
  let requests = 0;
  const operation = async () => {
    requests++;
    throw new HttpError(new Response('Invalid subscription key', { status: 401 }));
  };
  await assert.rejects(authorizedCall(operation, async () => { throw new Error('Unexpected refresh'); }), AccessError);
  assert.equal(requests, 1);
});

test('OAuth completion preserves credentials changed while the browser was open', {
  skip: process.platform !== 'linux' ? 'The production file-lock integration runs in Docker.' : false,
}, async context => {
  const fixture = await syntheticAuthorization();
  context.after(fixture.cleanup);
  const settings = await saveSettings({ clientId: fixture.config.client_id,
    clientSecret: 'synthetic-updated-secret', subscriptionKey: 'synthetic-updated-key' });
  assert.deepEqual(settings, await readSettings());
  assert(!JSON.stringify(settings).includes('synthetic-updated'));
  await completeAuthorization(fixture.config, 'synthetic-original-secret', 'synthetic-secret', {
    client_id: fixture.config.client_id, access_token: 'synthetic-access', expires_in: 3600,
  });
  const credentials = JSON.parse(await readFile(join(fixture.directory, 'credentials.json'), 'utf8'));
  assert.equal(credentials.client_secret, 'synthetic-updated-secret');
  assert.equal(credentials.subscription_key, 'synthetic-updated-key');
  assert.match((await loadTokens()).authorization_id, /^[a-f0-9]{32}$/);
});
