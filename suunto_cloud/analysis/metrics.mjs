import { timestampMs } from '../timezones.mjs';

export const number = value => Number.isFinite(value);
export const seconds = value => timestampMs(value) / 1000;

export function lowerBound(values, target, afterEqual = false) {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (values[middle] < target || (afterEqual && values[middle] === target)) start = middle + 1;
    else end = middle;
  }
  return start;
}

export function sum(values) {
  let total = 0;
  let correction = 0;
  for (const value of values) {
    const next = total + value;
    correction += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total;
    total = next;
  }
  return total + correction;
}

export function mean(values) {
  if (!values.length) return NaN;
  // An exact sum followed by one rounding keeps fractional sensor values
  // compatible with the former statistics.mean implementation.
  const binary = new DataView(new ArrayBuffer(8));
  const fractionMask = (1n << 52n) - 1n;
  let total = 0n;
  let unit = 0;
  for (const value of values) {
    if (!value) continue;
    binary.setFloat64(0, value);
    const bits = binary.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 2047n);
    const scale = exponent ? exponent - 1075 : -1074;
    const mantissa = (bits & fractionMask) + (exponent ? 1n << 52n : 0n);
    const signed = value < 0 ? -mantissa : mantissa;
    if (scale < unit) {
      total <<= BigInt(unit - scale);
      unit = scale;
    }
    total += signed << BigInt(scale - unit);
  }
  if (!total) return 0;
  const magnitude = total < 0n ? -total : total;
  const count = BigInt(values.length);
  let precision = magnitude.toString(2).length - count.toString(2).length;
  if (precision < 0 ? magnitude << BigInt(-precision) < count : magnitude < count << BigInt(precision)) precision--;
  const shift = Math.max(precision - 52, -1074 - unit);
  const numerator = shift < 0 ? magnitude << BigInt(-shift) : magnitude;
  const denominator = shift > 0 ? count << BigInt(shift) : count;
  let result = numerator / denominator;
  const remainder = 2n * (numerator % denominator);
  if (remainder > denominator || (remainder === denominator && result % 2n)) result++;
  return (total < 0n ? -1 : 1) * Number(result) * 2 ** (unit + shift);
}

export function timerRanges(intervals) {
  return intervals.map(({ start, end }) => [seconds(start), seconds(end)]);
}

export function activeSamples(data, timer) {
  const intervals = timerRanges(timer.active_segments);
  const rows = (data.records ?? []).filter(row => row.timestamp)
    .map(row => [seconds(row.timestamp), row]).sort(([first], [second]) => first - second);
  let index = 0;
  return rows.filter(([time]) => {
    while (index < intervals.length && time >= intervals[index][1]) index++;
    return index < intervals.length && intervals[index][0] <= time;
  });
}

export function stepLength(row) {
  return row.speed > 0 && row.cadence > 0 && number(row.speed) && number(row.cadence)
    ? 30 * row.speed / row.cadence : null;
}

function sampleStatistics(rows) {
  const counts = {};
  const fields = ['heart_rate', 'speed', 'power', 'cadence', 'stance_time', 'vertical_oscillation', 'ddfa'];
  const paired = [];
  for (const [, row] of rows) {
    for (const field of fields) {
      if (number(row[field])) counts[field] = (counts[field] ?? 0) + 1;
    }
    if (stepLength(row) !== null && number(row.stance_time) && number(row.vertical_oscillation)) paired.push(row);
  }
  const result = { record_count: rows.length, field_sample_counts: counts, mechanics_paired_count: paired.length };
  if (paired.length) {
    result.mechanics = {
      cadence_steps_per_min: mean(paired.map(row => 2 * row.cadence)),
      ground_contact_ms: mean(paired.map(row => row.stance_time)),
      vertical_oscillation_cm: mean(paired.map(row => row.vertical_oscillation / 10)),
      estimated_step_length_m: mean(paired.map(stepLength)),
    };
  }
  return result;
}

function recoveryDetails(guided, rows, timer) {
  const heartrate = rows.filter(([, row]) => number(row.heart_rate));
  const times = heartrate.map(([time]) => time);
  const pauses = timerRanges(timer.pauses);
  const lastHr = (time, notBefore) => {
    const observation = heartrate[lowerBound(times, time, true) - 1];
    if (!observation || time - observation[0] > 3 || observation[0] < notBefore) return null;
    return { bpm: observation[1].heart_rate, age_seconds: time - observation[0] };
  };
  const recoveries = [];
  for (let index = 1; index < guided.length; index++) {
    const [workIndex, work] = guided[index - 1];
    const [restIndex, rest] = guided[index];
    const [distance, duration, nextDistance, nextDuration] = [
      work.total_distance, work.total_timer_time, rest.total_distance, rest.total_timer_time,
    ];
    if (![distance, duration, nextDistance, nextDuration].every(value => number(value) && value > 0)) continue;
    if (distance / duration <= nextDistance / nextDuration) continue;
    const start = seconds(rest.start_time);
    const end = seconds(rest.timestamp);
    const workEnd = seconds(work.timestamp);
    if (Math.abs(start - workEnd) > 2) continue;
    const paused = pauses.some(([from, to]) => from < end && to > start);
    const initial = lastHr(workEnd, seconds(work.start_time));
    const after60 = end > start + 60 && !paused ? lastHr(start + 60, start) : null;
    recoveries.push({
      work_lap_index: workIndex, slower_next_lap_index: restIndex,
      pause_in_next_lap: paused, hr_at_work_end: initial,
      hr_after_60_elapsed_seconds: after60, hr_at_next_lap_end: lastHr(end, start),
      hr_drop_after_60_seconds: initial && after60 ? initial.bpm - after60.bpm : null,
    });
  }
  return recoveries;
}

function altitudeProfile(rows) {
  const measured = rows.filter(([, row]) => number(row.altitude)).map(([, row]) => row);
  if (!measured.length) return null;
  let minimum = measured[0];
  let maximum = measured[0];
  for (const row of measured) {
    if (row.altitude < minimum.altitude) minimum = row;
    if (row.altitude > maximum.altitude) maximum = row;
  }
  return {
    first_altitude_m: measured[0].altitude, last_altitude_m: measured.at(-1).altitude,
    minimum_altitude_m: minimum.altitude, maximum_altitude_m: maximum.altitude,
    minimum_at_distance_m: minimum.distance ?? null, maximum_at_distance_m: maximum.distance ?? null,
  };
}

export function additionalDetails(data, timer) {
  const rows = activeSamples(data, timer);
  const times = rows.map(([time]) => time);
  const laps = (data.laps ?? []).map((lap, index) => [index + 1, lap]);
  const guided = laps.filter(([, lap]) => lap.event === 'workout_step');
  const distance = laps.filter(([, lap]) => lap.lap_trigger === 'distance');
  const selected = guided.length ? guided : distance.length ? distance : laps;
  const lapSamples = selected.map(([index, lap]) => {
    const start = lowerBound(times, seconds(lap.start_time));
    const end = lowerBound(times, seconds(lap.timestamp));
    return { lap_index: index, ...sampleStatistics(rows.slice(start, end)) };
  });
  const channels = (data.field_descriptions ?? []).filter(field => field.suuntoplus_field_label && field.field_name)
    .map(field => {
      const name = field.field_name;
      const values = rows.map(([, row]) => row[name]).filter(number);
      return {
        field: name, label: field.suuntoplus_field_label, unit: field.units ?? null,
        active_sample_count: values.length, first_active_value: values[0] ?? null,
        last_active_value: values.at(-1) ?? null, session_value: data.sessions[0][name] ?? null,
      };
    });
  return {
    method: 'Arithmetic means of joint observed active samples; no interpolation. ' +
      'Cadence cycles/min x2; vertical oscillation mm/10; stance time ms; ' +
      'step length = 30 * speed_mps / cadence_cycles_per_min. ' +
      'HR changes use last observed values no older than 3 seconds; not a clinical HRR test.',
    active: sampleStatistics(rows), preferred_lap_kind: guided.length ? 'guided' : 'other',
    preferred_lap_indices: selected.map(([index]) => index), lap_samples: lapSamples,
    slower_next_lap_hr_changes: recoveryDetails(guided, rows, timer), suuntoplus_channels: channels,
    altitude_profile: altitudeProfile(rows),
    steady_state_metrics: 'Require comparable steady active segments; not inferred automatically.',
    rr_artifact_assessment: 'Not performed; RR counts do not constitute an HRV interpretation.',
  };
}
