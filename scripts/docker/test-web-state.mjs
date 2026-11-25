// Run inside the smoke-test worker against a separate synthetic database.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './web/server/store.ts';
import { InterpretationProviderError, interpretWorkout } from './web/server/interpretation.ts';

const directory = mkdtempSync(join(tmpdir(), 'suunto-smoke-'));
let store = new Store(directory);
try {
  const now = 1_700_000_000_000;
  const lease = 30_000;
  store.observeAuthorization('synthetic-original', now);
  const first = store.claim(now, lease);
  assert.equal(first.kind, 'sync');
  store.failed(first, { code: 'AUTH_REQUIRED', message: 'Synthetic authorization failure.' }, now + 1);
  store.close();
  store = new Store(directory);
  store.observeAuthorization('synthetic-original', now + 2);
  assert.equal(store.claim(now + 2, lease), undefined);
  assert.equal(store.status().authorized, false);
  assert.equal(store.status().lastSyncResult.status, 'failed');
  store.observeAuthorization('synthetic-updated', now + 3);
  const retry = store.claim(now + 3, lease);
  assert.equal(retry.kind, 'sync');
  assert.equal(store.status().lastSyncResult.id, first.id);
  assert(store.finishSync(retry, { workouts: [], highWatermark: now }, now + 4));
  store.observeAuthorization('synthetic-updated', now + 5);
  assert.equal(store.claim(now + 5, lease), undefined);
  assert.equal(store.status().lastSyncResult.status, 'done');
  assert.equal(store.status().lastSyncResult.id, retry.id);

  const key = join(directory, 'synthetic-openai-key');
  writeFileSync(key, 'SYNTHETIC_OPENAI_SMOKE_KEY');
  process.env.OPENAI_API_KEY_FILE = key;
  globalThis.fetch = async () => Response.json({ error: { message: 'Synthetic private upstream detail' } }, { status: 401 });
  await assert.rejects(interpretWorkout({ sport: 'running', metrics: {}, laps: [], observations: [] }),
    (error) => error instanceof InterpretationProviderError && /^OpenAI rejected the API key\./.test(error.message));
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
