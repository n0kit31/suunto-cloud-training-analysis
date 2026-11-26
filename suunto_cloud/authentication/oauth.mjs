import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { AccessError, loadSavedCredentials, responseError, saveTokens, tokenRequest, tokenUrl } from './access.mjs';
import { isObject, readConfig, withAuthenticationLock } from '../storage/local.mjs';

const authorizeUrl = 'https://cloudapi-oauth.suunto.com/oauth/authorize';
const recognized = new Set(['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'unauthorized']);
export class TokenExchangeError extends Error {}

export function parseCallback(path, expectedState, callbackPath) {
  const url = new URL(path, 'http://127.0.0.1');
  if (url.pathname !== callbackPath) throw Object.assign(new Error('Unknown callback path.'), { status: 404 });
  const states = url.searchParams.getAll('state');
  const actual = Buffer.from(states[0] ?? '');
  const expected = Buffer.from(expectedState);
  if (states.length !== 1 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid OAuth state. Use the link from the current run.');
  }
  if (url.searchParams.has('error')) return null;
  const codes = url.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0]) throw new Error('Expected exactly one nonempty authorization code.');
  return codes[0];
}

export async function exchangeCode(config, secret, code, fetcher = fetch) {
  const response = await tokenRequest(config.client_id, secret, {
    grant_type: 'authorization_code', redirect_uri: config.redirect_uri, code,
  }, fetcher);
  if (!response.ok) {
    const reason = await responseError(response);
    let message = `Authorization code exchange: HTTP ${response.status} from ${tokenUrl}.`;
    if (recognized.has(reason)) message += ` OAuth error: ${reason}.`;
    if (reason === 'invalid_grant') {
      message += ' Run the command again for a new code and check that the Redirect URI matches the application settings.';
    } else if (response.status === 401 || ['invalid_client', 'unauthorized_client'].includes(reason)) {
      message += ' Check the Client ID + Client secret pair in OAuth application settings.' +
        ' The client secret is an application credential, separate from the API Zone password,' +
        ' Suunto App password, and Primary/Secondary Developer API keys.' +
        ' The API Zone account may differ from the account connected to the watch.';
    } else {
      message += ' Check the OAuth configuration and try again using a new link.';
    }
    throw new TokenExchangeError(message);
  }
  const tokens = await response.json();
  if (!isObject(tokens) || typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error('Suunto did not return an access_token.');
  }
  return { ...tokens, received_at_unix: Math.floor(Date.now() / 1000), client_id: config.client_id };
}

async function existingCredentials(clientId) {
  try {
    return await loadSavedCredentials(clientId);
  } catch (error) {
    if (error instanceof AccessError) return {};
    throw error;
  }
}

export function completeAuthorization(config, secret, initialSecret, tokens) {
  return withAuthenticationLock(async () => {
    const current = await readConfig();
    if (current.client_id !== config.client_id || current.redirect_uri !== config.redirect_uri) {
      throw new Error('Suunto application settings changed during authorization. Start OAuth again.');
    }
    const saved = await existingCredentials(config.client_id);
    const updated = saved.client_secret;
    await saveTokens({ ...saved, client_id: config.client_id,
      client_secret: updated && updated !== initialSecret ? updated : secret }, 'credentials.json');
    return saveTokens({ ...tokens, authorization_id: randomBytes(16).toString('hex') });
  });
}

function listenForCallback(redirect, host, port, state, receive) {
  const server = createServer({ requestTimeout: 5000 }, (request, response) => {
    let status = 200;
    let message;
    let code;
    try {
      if (request.method !== 'GET' || request.headers.host !== host) throw new Error('Invalid callback address.');
      code = parseCallback(request.url, state, redirect.pathname);
      message = code ? 'Suunto authorization code received. Return to the terminal to check the token exchange result.'
        : 'Authorization was not granted. Return to the terminal.';
    } catch (error) {
      status = error.status ?? 400;
      message = error.message;
    }
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(message), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    response.end(message);
    if (status === 200) receive(code);
  });
  const bind = process.env.SUUNTO_OAUTH_BIND_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(bind)) throw new Error('SUUNTO_OAUTH_BIND_HOST must be 127.0.0.1 or 0.0.0.0.');
  server.setTimeout(5000, socket => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export async function authorize(config, prompt, forcePrompt, signal) {
  if (!config.client_id || config.client_id === 'YOUR_SUUNTO_CLIENT_ID' || !config.redirect_uri) {
    throw new Error('Configure the Suunto OAuth application before signing in.');
  }
  const redirect = URL.parse(config.redirect_uri);
  const host = /^http:\/\/(127\.0\.0\.1:(\d+))\//.exec(config.redirect_uri);
  const port = Number(host?.[2]);
  if (!redirect || !host || !port || port > 65535 || redirect.username || redirect.password ||
      redirect.search || redirect.hash || !redirect.pathname) {
    throw new Error('Callback must use the format http://127.0.0.1:PORT/path.');
  }
  const state = randomBytes(32).toString('base64url');
  const callback = Promise.withResolvers();
  const server = await listenForCallback(redirect, host[1], port, state, callback.resolve);
  let timeout;
  const interrupted = () => callback.reject(signal.reason);
  try {
    const saved = await existingCredentials(config.client_id);
    let secret = forcePrompt ? null : process.env.SUUNTO_CLIENT_SECRET || saved.client_secret;
    if (secret) console.log('Client secret: using saved configuration or an environment variable.');
    else secret = await prompt('Application client secret from OAuth application settings (not the account password): ');
    if (!secret) throw new Error('Client secret is required.');
    signal.throwIfAborted();
    signal.addEventListener('abort', interrupted, { once: true });
    const url = new URL(authorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: config.client_id, redirect_uri: config.redirect_uri, state,
    });
    console.log(`Application Client ID: ${config.client_id}`);
    console.log('Open the following link on this computer and authorize your Suunto App account:');
    console.log('In the browser, use the account from the phone app connected to your watch.');
    console.log(url.href);
    console.log('Waiting for callback (10 minutes)...');
    timeout = setTimeout(() => callback.reject(new Error('No callback received within 10 minutes.')), 600_000);
    const code = await callback.promise;
    if (code === null) throw new Error('Suunto denied authorization or reported an authorization error.');
    console.log('Valid callback received. Exchanging authorization code for tokens...');
    const tokens = await exchangeCode(config, secret, code);
    return await completeAuthorization(config, secret, saved.client_secret, tokens);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', interrupted);
    server.close();
  }
}
