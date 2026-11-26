import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeFit } from '../../suunto_cloud/analysis/fit.mjs';

function workout() {
  const at = seconds => new Date(Date.UTC(2026, 10, 5, 16, 0, seconds)).toISOString();
  const lap = (from, to, distance, event, trigger) => ({
    start_time: at(from), timestamp: at(to), event, lap_trigger: trigger,
    total_distance: distance, total_timer_time: to - from,
  });
  return {
    sessions: [{ start_time: at(0), timestamp: at(150), sport: 'running' }],
    events: [['start', 0], ['stop', 150]].map(([event_type, time]) =>
      ({ event: 'timer', event_type, timestamp: at(time) })),
    records: Array.from({ length: 150 }, (_, second) => {
      const running = second < 60;
      return {
        timestamp: at(second), heart_rate: running ? 160 : 160 - (second - 60) / 2,
        speed: running ? 4 : 2, cadence: running ? 100 : 90, stance_time: running ? 210 : 280,
        vertical_oscillation: 60, altitude: 50 + second / 100,
        distance: running ? 4 * second : 240 + 2 * (second - 60), estimate: 14000 + second,
      };
    }),
    laps: [lap(0, 150, 420, 'lap', 'distance'), lap(0, 60, 240, 'workout_step'),
      lap(60, 150, 180, 'workout_step')],
    field_descriptions: [{ field_name: 'estimate', units: 's', suuntoplus_field_label: 'Marathon time(est)' }],
  };
}

test('FIT analysis uses guided laps, observed mechanics and SuuntoPlus fields', () => {
  const data = workout();
  const result = summarizeFit(data, 'Europe/Warsaw');
  const details = result.additional_metrics;
  assert.deepEqual(details.preferred_lap_indices, [2, 3]);
  assert.equal(result.laps[1].start_local, '2026-11-05T17:00:00+01:00');
  assert.deepEqual(details.lap_samples[0].mechanics, {
    cadence_steps_per_min: 200, ground_contact_ms: 210,
    vertical_oscillation_cm: 6, estimated_step_length_m: 1.2,
  });
  assert.equal(details.slower_next_lap_hr_changes[0].hr_drop_after_60_seconds, 30);
  assert.equal(details.suuntoplus_channels[0].last_active_value, 14149);
  assert.equal(data.records.length, 150);
});

test('repeated stops preserve the full pause and exclude its measurements', () => {
  const data = workout();
  for (const [event_type, time] of [['stop', 90], ['stop_all', 100], ['start', 120]]) {
    data.events.push({ event: 'timer', event_type, timestamp: data.records[time].timestamp });
  }
  data.records[100].heart_rate = 250;
  const result = summarizeFit(data);
  assert.equal(result.timer.pause_seconds_from_rounded_events, 30);
  assert.deepEqual(result.timer.repeated_stop_events, [data.records[100].timestamp]);
  assert.equal(result.active_hr_sample_count, 120);
  assert.equal(result.hr_peak_records_active_only[0].heart_rate, 160);
  assert.equal(result.additional_metrics.slower_next_lap_hr_changes[0].hr_drop_after_60_seconds, null);
});
