import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryContext } from '../../suunto_cloud/analysis/sleep.mjs';
import { recoveryHeader, recoveryMarkdown } from '../../suunto_cloud/reporting/recovery.mjs';

const workout = { start_local: '2026-01-15T09:00:00+00:00', stop_local: '2026-01-15T10:00:00+00:00', timezone: 'UTC' };
function night(day, hrv, extra = {}) {
  const before = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
  return { entryData: { SleepId: day, BedtimeStart: before + 'T22:00:00Z', BedtimeEnd: day + 'T06:00:00Z',
    AvgHRV: hrv, AvgHRVSampleCount: 12, DeepSleepDuration: 4800, LightSleepDuration: 18000,
    REMSleepDuration: 6000, SleepQualityScore: 80, HRAvg: 49, HRMin: 41, ...extra } };
}

test('recovery uses one complete night per wake date and excludes the selected and future nights from the baseline', () => {
  const history = Array.from({ length: 14 }, (_, i) => night(`2026-01-${String(i + 1).padStart(2, '0')}`, 50));
  const before = night('2026-01-15', 70, { MaxSpo2: .98 });
  const duplicate = night('2026-01-15', 300, { AvgHRVSampleCount: 0 });
  const after = night('2026-01-16', 75, { MaxSpo2: .97 });
  const context = recoveryContext(workout, { data: [...history, before, duplicate, after] });
  assert.equal(context.reference_60d.night_count, 14);
  assert.equal(context.reference_60d.median_ms, 50);
  assert.equal(context.before.hrv_ms, 70);
  assert.equal(context.after.hrv_ms, 75);
  assert.equal(context.after_hrv_change_ms, 5);
  assert.equal(context.hrv_7d.average_ms, 370 / 7);
  assert.equal(context.statuses.hrv_ms, 'red');
  assert.equal(context.before.sleep_seconds, 28800);
  assert.equal(context.before.spo2_max_pct, 98);
});

test('sleep and SpO₂ charts share the calendar history and keep the night after separate', () => {
  const context = recoveryContext(workout, { data: [night('2026-01-15', 52, { MaxSpo2: .98 }),
    night('2026-01-16', 55, { MaxSpo2: .97 })] });
  const report = recoveryMarkdown(context).join('\n');
  const svg = recoveryHeader(context, 4, 0).lines.join('\n');
  assert.match(report, /Night after workout/);
  assert.match(report, /HRV change from the pre-workout night: \+3 ms/);
  assert.match(svg, /data-role="after-workout"/);
  assert.match(svg, /data-section="spo2-history"/);
  assert.match(svg, /data-stage="deep"/);
  assert.match(svg, /data-status="green"/);
  assert.doesNotMatch(svg, /data-role="hrv-7d-mean"/);
});
