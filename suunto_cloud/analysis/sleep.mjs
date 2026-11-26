import { localTimestamp } from '../timezones.mjs';
import { isObject } from '../storage/local.mjs';
import { mean, number, sum } from './metrics.mjs';

const dayMs = 86400000;
const fields = ['hrv_ms', 'sleep_seconds', 'quality_score', 'hr_avg_bpm'];
const time = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const day = value => Date.parse(value + 'T00:00:00Z');
const isoDay = value => new Date(value).toISOString().slice(0, 10);
const metric = (data, field, positive = false) =>
  number(data[field]) && (positive ? data[field] > 0 : data[field] >= 0) ? data[field] : null;

function sleepRecords(payload, zone) {
  const records = new Map();
  for (const sample of payload.data) {
    const data = sample.entryData;
    if (!isObject(data) || data.IsNap === true) continue;
    const start = time(data.BedtimeStart);
    const end = time(data.BedtimeEnd);
    if (!(end > start)) continue;
    const count = metric(data, 'AvgHRVSampleCount', true);
    const hrv = data.AvgHRVSampleCount != null && count === null ? null : metric(data, 'AvgHRV', true);
    const stages = ['DeepSleepDuration', 'LightSleepDuration', 'REMSleepDuration'].map(field => metric(data, field));
    const stageTotal = stages.every(value => value !== null) ? sum(stages) : 0;
    const duration = stageTotal || metric(data, 'Duration', true);
    const spo2 = metric(data, 'MaxSpo2', true);
    const localEnd = localTimestamp(end, zone);
    const record = {
      sleep_id: data.SleepId ?? null, start: localTimestamp(start, zone), end: localEnd, wake_date: localEnd.slice(0, 10),
      sleep_seconds: duration, duration_method: stageTotal ? 'sum_of_sleep_stages' : 'Suunto Duration',
      stages_seconds: { deep: stages[0], light: stages[1], rem: stages[2] },
      quality_score: metric(data, 'SleepQualityScore'), hr_avg_bpm: metric(data, 'HRAvg', true),
      hr_min_bpm: metric(data, 'HRMin', true), hrv_ms: hrv, hrv_sample_count: count,
      spo2_max_pct: spo2 !== null && spo2 <= 1 ? spo2 * 100 : null,
    };
    const key = data.SleepId == null ? JSON.stringify([start, end]) : String(data.SleepId);
    const score = [[duration, record.quality_score, record.hr_avg_bpm, record.hr_min_bpm, hrv, ...stages]
      .filter(value => value !== null).length, count || 0, end, Number(record.spo2_max_pct !== null)];
    const previous = records.get(key)?.score;
    const changed = previous ? score.findIndex((value, index) => value !== previous[index]) : -1;
    if (!previous || changed === -1 || score[changed] > previous[changed]) records.set(key, { score, record });
  }
  return [...records.values()].map(({ record }) => record).sort((a, b) => time(a.end) - time(b.end));
}

function reference(values) {
  if (values.length < 14) return null;
  const ordered = values.toSorted((a, b) => a - b);
  const percentile = fraction => {
    const position = (ordered.length - 1) * fraction;
    const index = Math.floor(position);
    return ordered[index] + (position - index) * (ordered[Math.min(index + 1, ordered.length - 1)] - ordered[index]);
  };
  const low = percentile(.1), high = percentile(.9), median = percentile(.5);
  const margin = Math.max((high - low) / 2, Math.abs(median) * .1, 1e-9);
  return { low, high, median, outer_low: Math.max(0, low - margin), outer_high: high + margin,
    night_count: values.length, outer_margin: margin };
}

export function deviationStatus(value, range) {
  if (value == null || !range) return 'unknown';
  if (value >= range.low && value <= range.high) return 'green';
  if (value >= range.outer_low && value <= range.outer_high) return 'yellow';
  return 'red';
}

export function recoveryContext(cloud, payload) {
  if (payload == null) return null;
  const start = time(cloud.start_local), stop = time(cloud.stop_local);
  const zone = cloud.timezone !== 'system local' ? cloud.timezone || undefined : undefined;
  const records = sleepRecords(payload, zone);
  const completed = records.filter(row => time(row.end) <= start);
  const recent = completed.filter(row => start - time(row.end) <= dayMs);
  const before = recent.at(-1) ?? null;
  const anchor = day(before?.wake_date ?? localTimestamp(start, zone).slice(0, 10));
  const byDay = new Map();
  for (const row of completed) {
    const date = day(row.wake_date);
    if (!byDay.has(date) || (row.sleep_seconds || 0) >= (byDay.get(date).sleep_seconds || 0)) byDay.set(date, row);
  }
  const history = [...byDay].filter(([date]) => date >= anchor - 60 * dayMs && date < anchor).map(([, row]) => row);
  const lastWeek = [...byDay].filter(([date]) => date >= anchor - 6 * dayMs && date <= anchor)
    .map(([, row]) => row.hrv_ms).filter(number);
  const values = field => history.map(row => row[field]).filter(number);
  const references = Object.fromEntries(fields.map(field => [field, reference(values(field))]));
  const ref = references.hrv_ms;
  const after = records.find(row => time(row.start) >= stop && time(row.start) <= stop + dayMs) ?? null;
  const average = lastWeek.length >= 3 ? mean(lastWeek) : null;
  const statuses = Object.fromEntries(fields.map(field => [field, deviationStatus(before?.[field], references[field])]));
  statuses.hrv_7d = deviationStatus(average, ref);
  const severity = ['unknown', 'green', 'yellow', 'red'];
  statuses.sleep = severity[Math.max(severity.indexOf(statuses.sleep_seconds), severity.indexOf(statuses.quality_score))];
  const nights = Array.from({ length: 7 }, (_, index) => {
    const date = anchor - (6 - index) * dayMs;
    return { wake_date: isoDay(date), sleep: byDay.get(date) ?? null };
  });
  return {
    source: Object.hasOwn(payload, 'source') ? payload.source : 'suunto_247_import',
    retrieved_at_utc: payload.retrieved_at_utc ?? null, before, after,
    hrv_7d: { average_ms: average, night_count: lastWeek.length, minimum_nights: 3, window_end: isoDay(anchor) },
    reference_60d: ref ? {
      median_ms: ref.median, low_ms: ref.low, high_ms: ref.high, night_count: ref.night_count,
      method: 'Own descriptive reference: median and 10th–90th percentiles of one main sleep per wake date in the preceding 60 calendar days; excludes the selected night. Not the Suunto normal range or readiness status.',
    } : null,
    reference_night_count: values('hrv_ms').length, references, statuses, nights_7d: nights,
    color_method: 'Calculated historical deviation, not Suunto readiness or a medical alert. ' +
      'Green: within the 10th–90th percentiles of the preceding 60 days. ' +
      'Yellow: outside that band but inside outer limits. Red: beyond outer limits. ' +
      'Outer limits extend each band edge by max(half the band width, 10% of its median). ' +
      'Both directions count as deviation. Sleep uses the worse available comparison ' +
      'of duration and quality. Gray: no comparison or reference-only tile. ' +
      'At least 14 nights per metric; the selected and subsequent nights are excluded.',
    after_hrv_change_ms: number(after?.hrv_ms) && number(before?.hrv_ms) ? after.hrv_ms - before.hrv_ms : null,
    method: 'Last completed non-nap sleep within 24 h before the workout. ' +
      'Seven-day mean uses available nights, minimum three; no missing nights are imputed. ' +
      'All pre-workout statistics exclude sleep ending after workout start. ' +
      'After-workout sleep is separate and does not establish the cause of HRV changes. ' +
      'Nighttime HR is not daytime resting HR.',
  };
}
