import { join } from 'node:path';
import { AccessError, loadSavedCredentials } from './access.mjs';
import { authenticationDirectory, isObject, privateJson, readConfig, withAuthenticationLock } from '../storage/local.mjs';

export const defaultCallback = 'http://127.0.0.1:8765/callback';
const fields = ['clientId', 'clientSecret', 'subscriptionKey'];
export class InvalidSettings extends Error {}

async function configuration() {
  const config = await readConfig();
  const value = config.client_id;
  return { config, client: typeof value === 'string' && value !== 'YOUR_SUUNTO_CLIENT_ID' && value.trim() ? value : null };
}

async function existing(client) {
  if (client) {
    try {
      return await loadSavedCredentials(client);
    } catch (error) {
      if (!(error instanceof AccessError || error instanceof SyntaxError)) throw error;
    }
  }
  return {};
}

const savedKey = (credentials, field) => typeof credentials[field] === 'string' ? credentials[field].trim() : '';

export async function readSettings() {
  const { config, client } = await configuration();
  const credentials = await existing(client);
  return {
    clientId: client, redirectUri: config.redirect_uri || defaultCallback,
    clientSecretSaved: Boolean(savedKey(credentials, 'client_secret')),
    subscriptionKeySaved: Boolean(savedKey(credentials, 'subscription_key')),
  };
}

export async function saveSettings(payload) {
  if (!isObject(payload) || Object.keys(payload).length !== fields.length ||
      !fields.every(field => Object.hasOwn(payload, field))) {
    throw new InvalidSettings('Provide the Suunto client ID, secret and subscription key.');
  }
  if (fields.some(field => typeof payload[field] !== 'string' ||
      [...payload[field]].length > 512 || /[\x00-\x1f\x7f]/.test(payload[field]))) {
    throw new InvalidSettings('Check the format of your Suunto credentials.');
  }
  const client = payload.clientId.trim();
  if (!client || client.includes(':')) throw new InvalidSettings('Enter the client ID from Suunto API Zone.');
  await withAuthenticationLock(async () => {
    const { config, client: current } = await configuration();
    if (current && current !== client) throw new InvalidSettings('The client ID belongs to the existing Suunto configuration.');
    const credentials = await existing(current);
    const secret = payload.clientSecret.trim() || savedKey(credentials, 'client_secret');
    const subscription = payload.subscriptionKey.trim() || savedKey(credentials, 'subscription_key');
    if (!secret || !subscription) throw new InvalidSettings('Enter both the client secret and the subscription key.');
    const directory = await authenticationDirectory();
    if (current === null) await privateJson(join(directory, 'config.json'), {
      client_id: client, redirect_uri: config.redirect_uri || defaultCallback,
    });
    await privateJson(join(directory, 'credentials.json'), {
      ...credentials, client_id: client, client_secret: secret, subscription_key: subscription,
    });
  });
  return readSettings();
}
