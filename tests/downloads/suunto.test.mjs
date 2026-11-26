import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseWorkout, dateCutoff, fetchFit, paginatedWorkouts } from '../../suunto_cloud/downloads/cloud.mjs';
import { listWorkouts } from '../../suunto_cloud/web_bridge.mjs';

test('pagination retains activities that share a boundary millisecond', async () => {
  const row = (id, lastModified) => ({ workoutKey: String(id), lastModified });
  const first = Array.from({ length: 50 }, (_, index) => row(index, index < 49 ? 11 : 10));
  const tiedPage = Array.from({ length: 50 }, (_, index) => row(49 + index, 10));
  const last = [...tiedPage, row(99, 9)];
  const queries = [];
  const result = await paginatedWorkouts(query => {
    queries.push(query);
    return { payload: [first, tiedPage, last][queries.length - 1] };
  });
  assert.deepEqual(queries, [{}, { until: 11, limit: 50 }, { until: 11, limit: 100 }]);
  assert.equal(result.metadata.workoutcount, '100');
  assert.deepEqual(result.payload.slice(-2), [row(98, 10), row(99, 9)]);
});

test('fetching a redirected FIT omits both Suunto headers on the signed download', async () => {
  const credentials = ['synthetic-token', 'synthetic-subscription'];
  const signed = 'https://example.blob.core.windows.net/test/activity.fit';
  const fit = Buffer.from('00000000.FIT');
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: signed } }) : new Response(fit);
  };
  assert.deepEqual(await fetchFit('1'.repeat(24), ...credentials, fetch), fit);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer synthetic-token');
  assert.equal(calls[0].headers.get('ocp-apim-subscription-key'), 'synthetic-subscription');
  assert.equal(calls[1].url, signed);
  assert.equal(calls[1].headers.get('authorization'), null);
  assert.equal(calls[1].headers.get('ocp-apim-subscription-key'), null);
});

test('pagination rejects an upstream that ignores its cursor', async () => {
  const page = Array.from({ length: 50 }, (_, index) => ({ workoutKey: String(index), lastModified: 100 - index }));
  await assert.rejects(paginatedWorkouts(async () => ({ payload: page })), /ignored the pagination cursor/);
});

test('first sync selects by local calendar day and later sync selects by modification time', async t => {
  const previous = process.env.SUUNTO_TIMEZONE;
  process.env.SUUNTO_TIMEZONE = 'Europe/Warsaw';
  t.after(() => {
    if (previous === undefined) delete process.env.SUUNTO_TIMEZONE;
    else process.env.SUUNTO_TIMEZONE = previous;
  });
  const day = '2026-11-16';
  const cutoff = dateCutoff(day, 'Europe/Warsaw');
  assert.equal(cutoff, Date.parse('2026-11-15T23:00:00Z'));
  const now = Date.parse('2026-11-16T22:00:00Z');
  const recordings = [
    { workoutKey: '1'.repeat(24), startTime: cutoff - 1, lastModified: now - 1 },
    { workoutKey: '2'.repeat(24), startTime: cutoff, lastModified: now - 2 },
    { workoutKey: '3'.repeat(24), startTime: cutoff + 1, lastModified: now - 3 },
  ].map(record => ({ ...record, stopTime: record.startTime + 60000, extensionTypes: ['LOCATIONSTREAM'] }));
  const page = async () => recordings;
  const first = await listWorkouts({ sinceDays: 1 }, now, page);
  const later = await listWorkouts({ modifiedSince: now - 2 }, now, page);
  assert.equal(first.timeZone, 'Europe/Warsaw');
  assert.deepEqual(first.workouts.map(row => row.sourceKey), [recordings[1].workoutKey, recordings[2].workoutKey]);
  assert.deepEqual(later.workouts.map(row => row.sourceKey), [recordings[0].workoutKey, recordings[1].workoutKey]);
  assert.equal(first.highWatermark, now - 1);
  assert.throws(() => chooseWorkout(recordings, day, null, 'Europe/Warsaw'), /Multiple workouts/);
  assert.equal(chooseWorkout(recordings, day, recordings[1].workoutKey).workoutKey, recordings[1].workoutKey);
});

test('FIT download rejects an unrelated redirect and a non-FIT response', async () => {
  const credentials = ['1'.repeat(24), 'synthetic-token', 'synthetic-subscription'];
  let requests = 0;
  await assert.rejects(fetchFit(...credentials, async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'https://example.invalid/private.fit' } });
  }), /Unsupported FIT download redirect/);
  assert.equal(requests, 1);
  await assert.rejects(fetchFit(...credentials, async () => Response.json({ message: 'synthetic' })), /not return a binary FIT/);
});
