import { activityLabel, footActivity } from '../activities.mjs';
import { localTimestamp, timestampMs } from '../timezones.mjs';
import { number, sum } from './metrics.mjs';
import { workoutHighlights } from './workout_highlights.mjs';

function session(cloud) {
  const activity = activityLabel(cloud) ?? 'Activity';
  const foot = footActivity(cloud);
  const group = foot === 'running' ? 'Running' : foot === 'walking' ? 'Walking / hiking' :
    activityLabel(cloud) ?? 'Other activity';
  const keys = ['workout_key', 'activity_id', 'activity_name', 'start_local', 'distance_m',
    'active_seconds', 'pace_seconds_per_km', 'avg_hr_bpm', 'max_hr_bpm', 'ascent_m'];
  const tss = cloud.tss?.calculationMethod === 'HR' && number(cloud.tss.trainingStressScore)
    ? cloud.tss.trainingStressScore : cloud.hr_tss;
  return { ...Object.fromEntries(keys.map(key => [key, cloud[key] ?? null])),
    activity, group, hr_tss: number(tss) ? tss : null };
}

function splitPattern(analysis) {
  const preferred = analysis.additional_metrics?.preferred_lap_indices;
  const laps = (analysis.laps ?? []).filter(lap => (!preferred || preferred.includes(lap.index)) &&
    number(lap.distance_m) && Math.abs(lap.distance_m - 1000) < .01 && number(lap.pace_seconds_per_km));
  const faster = [];
  for (let index = 1; index < laps.length - 1; index++) {
    const [previous, current, next] = laps.slice(index - 1, index + 2);
    if (previous.index + 1 === current.index && current.index === next.index - 1 &&
        current.pace_seconds_per_km + 25 <= Math.min(previous.pace_seconds_per_km, next.pace_seconds_per_km)) {
      faster.push(index);
    }
  }
  if (faster.length < 3 || faster.slice(1).some((index, position) => index - faster[position] !== 2)) return null;
  const range = values => [Math.min(...values), Math.max(...values)];
  return {
    count: faster.length, distance_m_each: 1000, fast_pace_range: range(faster.map(index => laps[index].pace_seconds_per_km)),
    slower_pace_range: range(faster.map(index => laps[index + 1].pace_seconds_per_km)),
    method: 'At least three alternating full-kilometre laps, each at least 25 s/km ' +
      'faster than both neighbours. Describes recorded splits; terrain may affect pace.',
  };
}

export function chartSummary(cloud, analysis, peers = []) {
  const current = session(cloud);
  const zone = cloud.timezone && cloud.timezone !== 'system local' ? cloud.timezone : undefined;
  const localize = value => zone ? localTimestamp(timestampMs(value), zone) : value;
  current.start_local = localize(current.start_local);
  const day = new Date(current.start_local.slice(0, 10) + 'T00:00:00Z');
  const monday = day.getTime() - (day.getUTCDay() + 6) % 7 * 86400000;
  const firstDay = new Date(monday).toISOString().slice(0, 10);
  const lastDay = new Date(monday + 6 * 86400000).toISOString().slice(0, 10);
  const unique = new Map();
  for (const source of [...peers, cloud]) {
    const row = session(source);
    if (typeof row.start_local !== 'string' || !Number.isFinite(Date.parse(row.start_local))) continue;
    row.start_local = localize(row.start_local);
    const rowDay = row.start_local.slice(0, 10);
    if (rowDay < firstDay || rowDay > lastDay) continue;
    unique.set(row.workout_key || JSON.stringify([row.activity_id, row.start_local]), row);
  }
  const rows = [...unique.values()].sort((a, b) => timestampMs(a.start_local) - timestampMs(b.start_local));
  const comparable = rows.filter(row => row.group === current.group);
  const total = (items, field) => {
    const values = items.map(row => row[field]).filter(number);
    return values.length ? sum(values) : null;
  };
  const totals = {
    distance_m: total(comparable, 'distance_m'), active_seconds: total(comparable, 'active_seconds'),
    hr_tss: total(comparable, 'hr_tss'), hr_tss_count: comparable.filter(row => number(row.hr_tss)).length,
  };
  const ranks = Object.fromEntries(['distance_m', 'hr_tss'].map(field => {
    const value = current[field];
    const values = comparable.map(row => row[field]).filter(number);
    const highest = comparable.length > 1 && values.length === comparable.length && number(value) && value === Math.max(...values);
    return [field, highest ? values.filter(item => item === value).length === 1 ? 'highest' : 'joint_highest' : null];
  }));
  const other = [...new Set(rows.map(row => row.group))].filter(group => group !== current.group).sort().map(group => {
    const items = rows.filter(row => row.group === group);
    return { group, count: items.length, distance_m: total(items, 'distance_m'), active_seconds: total(items, 'active_seconds') };
  });
  const zones = cloud.intensity?.zones?.heartRate ?? {};
  const zoneTotal = keys => sum(keys.map(key => zones[key]?.totalTime).filter(number));
  return {
    workout: current, pte: cloud.summary?.pte ?? null, feeling: cloud.summary?.feeling ?? null,
    highlights: workoutHighlights(cloud, analysis), split_pattern: splitPattern(analysis),
    intensity: {
      classified_seconds: zoneTotal(Object.keys(zones)), easy_seconds: zoneTotal(['zone1', 'zone2']),
      high_seconds: zoneTotal(['zone4', 'zone5']),
    },
    week: {
      from: firstDay, to: lastDay, group: current.group, sessions: rows, comparable, totals, ranks, other,
      load_share_percent: number(current.hr_tss) && totals.hr_tss && totals.hr_tss_count === comparable.length
        ? 100 * current.hr_tss / totals.hr_tss : null,
      coverage: 'Available records for this calendar week; totals may be incomplete. ' +
        'Running and walking are counted separately. ' +
        'Pace and heart rate reflect differences in terrain and session structure.',
    },
  };
}
