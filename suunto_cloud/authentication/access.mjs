import { join } from 'node:path';
import {
  authenticationDirectory, isObject, privateJson, readConfig, readOptionalJson, withAuthenticationLock,
} from '../storage/local.mjs';
import { HttpError, NetworkError, limitedBody, request } from '../downloads/http.mjs';

export const tokenUrl = 'https://cloudapi-oauth.suunto.com/oauth/token';
export class AccessError extends Error {}
export class RefreshHttpError extends HttpError {
  constructor(response) {
    super(response);
    this.message = `OAuth refresh failed: HTTP ${this.status}. Tokens were not changed.`;
  }
}

export async function loadConfig() {
  const config = await readConfig();
  if (typeof config.client_id !== 'string' || !config.client_id || config.client_id === 'YOUR_SUUNTO_CLIENT_ID') {
    throw new AccessError('Missing Client ID in config.json.');
  }
  return config;
}

export async function loadSavedCredentials(clientId) {
  const data = await readOptionalJson(join(await authenticationDirectory(), 'credentials.json'), {});
  if (!isObject(data)) throw new AccessError('Invalid credentials.json format.');
  if (Object.keys(data).length && data.client_id !== clientId) {
    throw new AccessError('Saved credentials belong to a different Client ID. Run node suunto_cloud/cli.mjs access --configure.');
  }
  return data;
}

export async function loadCredentials() {
  const config = await loadConfig();
  const data = await loadSavedCredentials(config.client_id);
  for (const [field, variable] of [['client_secret', 'SUUNTO_CLIENT_SECRET'], ['subscription_key', 'SUUNTO_SUBSCRIPTION_KEY']]) {
    if (process.env[variable]) data[field] = process.env[variable].trim();
    if (Object.hasOwn(data, field) && typeof data[field] !== 'string') throw new AccessError('Invalid saved credential format.');
  }
  return { ...data, client_id: config.client_id };
}

export async function loadTokens() {
  const path = join(await authenticationDirectory(), 'tokens.json');
  const tokens = await readOptionalJson(path);
  if (tokens === undefined) throw new AccessError('No saved tokens. Run node suunto_cloud/cli.mjs oauth.');
  if (!isObject(tokens) || tokens.client_id !== (await loadConfig()).client_id) {
    throw new AccessError('Token and configuration Client IDs differ. Authorize again with node suunto_cloud/cli.mjs oauth.');
  }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new AccessError('No valid access token. Authorize with node suunto_cloud/cli.mjs oauth.');
  }
  return tokens;
}

export function isCurrent(tokens, now = Date.now() / 1000) {
  return Number(tokens.received_at_unix ?? 0) + Number(tokens.expires_in ?? 0) > now + 120;
}

export const saveTokens = async (tokens, file = 'tokens.json') =>
  privateJson(join(await authenticationDirectory(), file), tokens);

export function tokenRequest(clientId, secret, values, fetcher = fetch) {
  return request(tokenUrl, {
    method: 'POST', body: new URLSearchParams(values),
    headers: {
      Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
    },
  }, fetcher);
}

export async function responseError(response) {
  try {
    const data = JSON.parse((await limitedBody(response, 8192)).toString('utf8'));
    return isObject(data) ? data.error : undefined;
  } catch (error) {
    if (error instanceof NetworkError) throw error;
    return undefined;
  }
}

async function refreshTokens(tokens, credentials, fetcher) {
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new AccessError('Missing refresh token. Authorize again with node suunto_cloud/cli.mjs oauth.');
  }
  if (!credentials.client_secret) {
    throw new AccessError('No saved client secret. Run node suunto_cloud/cli.mjs access --configure.');
  }
  const response = await tokenRequest(credentials.client_id, credentials.client_secret, {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
  }, fetcher);
  if (!response.ok) {
    const error = await responseError(response);
    if (error === 'invalid_grant') {
      throw new AccessError('Refresh token rejected. Run node suunto_cloud/cli.mjs oauth to authorize again; do not paste tokens into chat.');
    }
    if (error === 'invalid_client' || response.status === 401) {
      throw new AccessError('OAuth refresh: check the client secret and Client ID; update saved credentials with node suunto_cloud/cli.mjs access --configure.');
    }
    throw new RefreshHttpError(response);
  }
  const data = await response.json();
  if (!isObject(data) || typeof data.access_token !== 'string' || !data.access_token) {
    throw new AccessError('Invalid refresh response. Tokens were not changed.');
  }
  const expiry = Math.trunc(Number(data.expires_in));
  if (!Number.isSafeInteger(expiry) || expiry <= 0 ||
      (Object.hasOwn(data, 'refresh_token') && (typeof data.refresh_token !== 'string' || !data.refresh_token))) {
    throw new AccessError('Invalid expiry or refresh token. Tokens were not changed.');
  }
  const updated = { ...tokens, ...data, client_id: credentials.client_id,
    expires_in: expiry, received_at_unix: Math.floor(Date.now() / 1000) };
  if (Object.hasOwn(tokens, 'authorization_id')) updated.authorization_id = tokens.authorization_id;
  else delete updated.authorization_id;
  await saveTokens(updated);
  return updated;
}

export function getAccessToken(force = false, rejectedToken = null, fetcher = fetch) {
  return withAuthenticationLock(async () => {
    const tokens = await loadTokens();
    if (isCurrent(tokens) && (!force || (rejectedToken !== null && tokens.access_token !== rejectedToken))) {
      return tokens.access_token;
    }
    return (await refreshTokens(tokens, await loadCredentials(), fetcher)).access_token;
  });
}

export async function authorizedCall(operation, fetcher = fetch) {
  const credentials = await loadCredentials();
  const key = credentials.subscription_key?.trim();
  if (!key) throw new AccessError('No saved Developer API key. Run node suunto_cloud/cli.mjs access --configure.');
  const token = await getAccessToken(false, null, fetcher);
  try {
    return await operation(token, key);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error;
    const body = (await limitedBody(error.response, 4096)).toString('utf8').toLowerCase();
    if (body.includes('subscription') && (body.includes('invalid') || body.includes('missing'))) {
      throw new AccessError('Cloud API rejected the subscription key; check it with node suunto_cloud/cli.mjs access --configure.');
    }
  }
  return operation(await getAccessToken(true, token, fetcher), key);
}

export function safeError(error) {
  if (error instanceof RefreshHttpError || error instanceof AccessError || error instanceof RangeError) return error.message;
  if (error instanceof HttpError) return `Suunto: HTTP ${error.status}. Check authorization, subscription, or API rate limits.`;
  if (error instanceof NetworkError) return 'Cannot connect to Suunto (DNS/network/TLS). No credentials were displayed.';
  return `Operation failed (${error.constructor.name}); authentication data is not displayed.`;
}
