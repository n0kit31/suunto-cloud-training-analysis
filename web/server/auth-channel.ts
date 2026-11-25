import { rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { dataDirectory } from './store.ts';
import type { Provider } from '../shared/providers.ts';
import type { AISettings } from './interpretation.ts';

export type SuuntoSettings = {
  clientId: string | null;
  redirectUri: string;
  clientSecretSaved: boolean;
  subscriptionKeySaved: boolean;
};

export type SuuntoSettingsUpdate = {
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
};

export type AISettingsUpdate = { apiKey: string };
const socketPath = join(dataDirectory, 'worker-auth.sock');
export const authBodyLimit = 8192;

async function readBody(stream: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > authBodyLimit) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startAuthChannel(
  settings: (command: 'settings-read' | 'settings-save', body?: string) => Promise<SuuntoSettings>,
  aiSettings: (provider: Provider, action: 'read' | 'save' | 'remove', update?: unknown) => Promise<AISettings>,
) {
  // Compose runs one worker. Replace a socket left behind by an interrupted container.
  await rm(socketPath, { force: true });
  const server = createServer({ requestTimeout: 5_000 }, async (incoming, response) => {
    const provider = incoming.url === '/openai-settings' ? 'openai' : incoming.url === '/claude-settings' ? 'claude' : undefined;
    if ((!provider && incoming.url !== '/settings') ||
      (incoming.method !== 'GET' && incoming.method !== 'POST' && !(provider && incoming.method === 'DELETE'))) {
      response.writeHead(404).end();
      return;
    }
    try {
      const values = incoming.method === 'POST' ? await readBody(incoming) : undefined;
      const action = incoming.method === 'DELETE' ? 'remove' : values === undefined ? 'read' : 'save';
      const result = provider ? await aiSettings(provider, action, values === undefined ? undefined : JSON.parse(values))
        : await settings(values === undefined ? 'settings-read' : 'settings-save', values);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      response.writeHead(code === 'SETTINGS_INVALID' ? 400 : code === 'SETTINGS_MANAGED' ? 409 : 503).end();
    }
  });
  server.setTimeout(5_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

function requestSettings<T>(path: '/settings' | `/${Provider}-settings`, update?: SuuntoSettingsUpdate | AISettingsUpdate | null) {
  const method = update === null ? 'DELETE' : update === undefined ? 'GET' : 'POST';
  const payload = update == null ? undefined : JSON.stringify(update);
  return new Promise<{ data?: T; status: number }>((resolve, reject) => {
    const outgoing = request({
      socketPath, path, method,
      headers: payload === undefined ? undefined : { 'Content-Length': Buffer.byteLength(payload) },
      signal: AbortSignal.timeout(6_000),
    }, async (incoming) => {
      const status = incoming.statusCode ?? 503;
      try {
        const body = await readBody(incoming);
        resolve(status === 200 ? { data: JSON.parse(body) as T, status } : { status });
      } catch (error) {
        reject(error);
      }
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

export function authSettings(update?: SuuntoSettingsUpdate) {
  return requestSettings<SuuntoSettings>('/settings', update);
}

export function aiSettings(provider: Provider, update?: AISettingsUpdate | null) {
  return requestSettings<AISettings>(`/${provider}-settings`, update);
}
