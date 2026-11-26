import assert from 'node:assert/strict';
import test from 'node:test';
import { dateCutoff } from '../suunto_cloud/downloads/cloud.mjs';
import { localTimestamp, timestampMs } from '../suunto_cloud/timezones.mjs';

test('local timestamps distinguish both occurrences of a DST hour and retain fractional seconds', () => {
  const zone = 'Europe/Warsaw';
  const first = '2026-10-25T00:30:00.123456Z';
  const second = '2026-10-25T01:30:00.123456Z';
  assert.equal(localTimestamp(timestampMs(first), zone), '2026-10-25T02:30:00.123456+02:00');
  assert.equal(localTimestamp(timestampMs(second), zone), '2026-10-25T02:30:00.123456+01:00');
  assert.equal(dateCutoff('2026-10-26', zone) - dateCutoff('2026-10-25', zone), 25 * 3600000);
});
