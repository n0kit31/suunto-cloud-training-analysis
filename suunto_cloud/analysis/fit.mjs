import { localTimestamp, timestampMs } from '../timezones.mjs';
import { additionalDetails, mean, number, seconds, sum, timerRanges } from './metrics.mjs';

const stopEvents = new Set(['stop', 'stop_all', 'stop_disable', 'stop_disable_all']);

export function timerIntervals(events) {
  let activeStart = null;
  let pauseStart = null;
  const pauses = [];
  const segments = [];
  const repeatedStops = [];
  const ordered = events.map(event => [seconds(event.timestamp), event]).sort(([a], [b]) => a - b);
  for (const [time, event] of ordered) {
    if (event.event !== 'timer') continue;
    if (event.event_type === 'start') {
      if (pauseStart !== null) {
        pauses.push({ start: pauseStart, end: event.timestamp, seconds: time - seconds(pauseStart) });
        pauseStart = null;
      }
      activeStart ??= event.timestamp;
    } else if (stopEvents.has(event.event_type)) {
      if (activeStart !== null) {
        segments.push({ start: activeStart, end: event.timestamp, seconds: time - seconds(activeStart) });
        activeStart = null;
        pauseStart = event.timestamp;
      } else if (pauseStart !== null) {
        repeatedStops.push(event.timestamp);
      }
    }
  }
  return {
    pauses, active_segments: segments, repeated_stop_events: repeatedStops,
    pause_seconds_from_rounded_events: sum(pauses.map(pause => pause.seconds)),
  };
}

function lapSummary(lap, index, zone) {
  const distance = Object.hasOwn(lap, 'total_distance') ? lap.total_distance : 0;
  const duration = lap.total_timer_time ?? null;
  return {
    index, trigger: lap.lap_trigger ?? null,
    start_local: localTimestamp(timestampMs(lap.start_time), zone),
    end_local: localTimestamp(timestampMs(lap.timestamp), zone),
    distance_m: distance, active_seconds: duration, elapsed_seconds: lap.total_elapsed_time ?? null,
    pace_seconds_per_km: distance && duration !== null ? duration / (distance / 1000) : null,
    avg_hr: lap.avg_heart_rate ?? null, max_hr: lap.max_heart_rate ?? null, avg_power_w: lap.avg_power ?? null,
    ascent_m: lap.total_ascent ?? null, descent_m: lap.total_descent ?? null,
  };
}

export function summarizeFit(data, zone) {
  const session = data.sessions?.[0];
  if (!session) throw new TypeError('The FIT file does not contain a session.');
  const timer = timerIntervals(data.events ?? []);
  const segments = timerRanges(timer.active_segments);
  const records = data.records ?? [];
  const active = record => {
    const time = seconds(record.timestamp);
    return segments.some(([start, end]) => start <= time && time < end);
  };
  const measured = records.filter(record => number(record.heart_rate) && active(record));
  const peak = measured.reduce((highest, record) => Math.max(highest, record.heart_rate), -Infinity);
  const peakFields = ['timestamp', 'distance', 'heart_rate', 'altitude', 'speed', 'power'];
  const peaks = measured.filter(record => record.heart_rate === peak).map(record =>
    Object.fromEntries(peakFields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])));
  const hrv = data.hrv ?? [];
  const result = {
    session, timezone: zone || 'system local', timer,
    laps: (data.laps ?? []).map((lap, index) => lapSummary(lap, index + 1, zone)),
    record_count: records.length, active_hr_sample_count: measured.length,
    active_hr_arithmetic_mean: measured.length ? mean(measured.map(record => record.heart_rate)) : null,
    hr_peak_records_active_only: peaks, hrv_message_count: hrv.length,
    rr_interval_count: sum(hrv.map(row => Array.isArray(row.time) ? row.time.length : 0)),
    ddfa_sample_count: records.filter(record => Object.hasOwn(record, 'ddfa')).length,
    gps_sample_count: records.filter(record => Object.hasOwn(record, 'position_lat') && Object.hasOwn(record, 'position_long')).length,
    notes: [
      'Timer events have whole-second timestamps; use session total_timer_time for exact duration.',
      'Arithmetic sample HR is descriptive, not a substitute for the device weighted average.',
      'No R-R artifact assessment or medical HRV analysis was performed.',
    ],
    additional_metrics: additionalDetails(data, timer),
  };
  if (peaks.length && Object.hasOwn(peaks[0], 'altitude')) {
    const peakTime = seconds(peaks[0].timestamp);
    let closest = null;
    let difference = Infinity;
    for (const record of records) {
      if (!Object.hasOwn(record, 'altitude') || !Object.hasOwn(record, 'timestamp')) continue;
      const age = peakTime - seconds(record.timestamp);
      if (age >= 55 && age <= 65 && Math.abs(age - 60) < difference && active(record)) {
        closest = record;
        difference = Math.abs(age - 60);
      }
    }
    if (closest) result.altitude_change_around_60s_before_hr_peak_m = peaks[0].altitude - closest.altitude;
  }
  return result;
}
