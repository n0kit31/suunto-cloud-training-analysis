import { cloudMetrics } from './cloud_metrics.mjs';
import { number, sum } from './metrics.mjs';
import { fixed } from '../reporting/format.mjs';

const files = ['cloud_summary_path', 'fit_path', 'decoded_path', 'analysis_path'];
const sampleColumns = ['record_count', 'active_hr_sample_count', 'rr_interval_count', 'ddfa_sample_count'];
const mechanics = ['cadence_steps_per_min', 'ground_contact_ms', 'vertical_oscillation_cm', 'estimated_step_length_m'];
const take = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key] ?? null]));
const select = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => keys.includes(key)));

function distanceBlock(rows, samples) {
  const duration = sum(rows.map(lap => lap.active_seconds));
  const distance = sum(rows.map(lap => lap.distance_m));
  const result = { first_lap: rows[0].index, last_lap: rows.at(-1).index, distance_m: distance,
    active_seconds: duration, pace_seconds_per_km: duration * 1000 / distance };
  for (const [source, target] of [['avg_hr', 'avg_hr_bpm'], ['avg_power_w', 'avg_power_w']]) {
    const available = rows.filter(lap => number(lap[source]));
    const covered = sum(available.map(lap => lap.active_seconds));
    result[target] = covered ? sum(available.map(lap => lap[source] * lap.active_seconds)) / covered : null;
    result[target + '_coverage'] = covered / duration;
  }
  const observations = rows.map(lap => samples.get(lap.index) ?? {});
  result.mechanics = Object.fromEntries(mechanics.map(field => {
    const pairs = observations.filter(row => row.mechanics?.[field] != null);
    const count = sum(pairs.map(row => row.mechanics_paired_count ?? 0));
    return [field, count ? sum(pairs.map(row => row.mechanics[field] * (row.mechanics_paired_count ?? 0))) / count : null];
  }));
  return result;
}

export function distanceBlocks(laps, samples) {
  if (laps.length < 10 || laps.slice(0, -1).some(lap => Math.abs((lap.distance_m || 0) - 1000) > .01)) return null;
  const last = laps.at(-1).distance_m || 0;
  if (last <= 0 || last > 1000.01 || laps.some(lap => !lap.active_seconds)) return null;
  const full = Math.abs(last - 1000) <= .01 ? laps : laps.slice(0, -1);
  const half = Math.floor(full.length / 2);
  const block = rows => distanceBlock(rows, samples);
  return {
    method: 'Disjoint selected kilometre laps; HR/power weighted by active lap time, mechanics by joint sample counts. ' +
      'Missing values excluded with coverage; no interpolation. Equal parts cover whole kilometres, not official race halves; not a formal drift test.',
    five_km: Array.from({ length: Math.ceil(laps.length / 5) }, (_, index) => block(laps.slice(5 * index, 5 * index + 5))),
    equal_parts: [block(full.slice(0, half)), block(full.slice(half, 2 * half))],
    remainder: laps.length > 2 * half ? block(laps.slice(2 * half)) : null,
  };
}

function compactFit({ hr_peak_records_active_only: peaks = [], ...analysis }) {
  return { ...analysis,
    hr_peak: { sample_count: peaks.length, first: peaks[0] ?? null, last: peaks.at(-1) ?? null, samples_preview: peaks.slice(0, 5) },
  };
}

function preferred(analysis) {
  const details = analysis.additional_metrics ?? {};
  const indices = new Set(details.preferred_lap_indices ?? analysis.laps.map(lap => lap.index));
  return { laps: analysis.laps.filter(lap => indices.has(lap.index)),
    samples: new Map((details.lap_samples ?? []).map(row => [row.lap_index, row])) };
}

export function buildPacket(manifest, records, analyses, zone) {
  const byKey = new Map(records.map(row => [row.workoutKey, row]));
  const keys = manifest.workouts.map(entry => entry.workout_key);
  const selected = keys.map(key => byKey.get(key));
  const activities = [...new Set(selected.map(row => row.activityId).filter(value => value != null))].sort((a, b) => a - b);
  const comparisonCandidates = activities.flatMap(id => {
    const before = Math.min(...selected.filter(row => row.activityId === id).map(row => row.startTime));
    return records.filter(row => row.activityId === id && row.startTime < before)
      .sort((a, b) => b.startTime - a.startTime).slice(0, 3).map(row => cloudMetrics(row, zone));
  });
  const workouts = manifest.workouts.map(entry => {
    const key = entry.workout_key;
    const fit = compactFit(analyses.get(key));
    const { laps, samples } = preferred(fit);
    return { cloud: cloudMetrics(byKey.get(key), zone), fit, distance_blocks: distanceBlocks(laps, samples),
      recovery: entry.recovery ?? null, files: take(entry, files),
      ...(Object.hasOwn(entry, 'outputs') ? { outputs: entry.outputs } : {}) };
  });
  return {
    retrieved_at_utc: manifest.retrieved_at_utc, requested_dates: manifest.requested_dates,
    timezone: zone || 'system local', complete: manifest.complete, workout_keys: keys,
    cloud_packet_count: records.length, history_completeness_verified: false,
    workouts, comparison_candidates: comparisonCandidates,
  };
}

export function briefPacket({ workouts, comparison_candidates: candidates, ...packet }) {
  const columns = ['lap', 'm', 'active_s', 'pace_s_per_km', 'hr_avg', 'hr_max', 'power_w',
    'ascent_m', 'descent_m', 'cadence_steps_min', 'contact_ms', 'oscillation_cm',
    'estimated_step_m', 'mechanics_samples', 'active_records'];
  return {
    ...packet,
    view: 'brief-v1; full data in .local/analysis.json and output JSON reports',
    workouts: workouts.map(workout => {
      const { cloud, fit } = workout;
      const { laps, samples } = preferred(fit);
      const details = fit.additional_metrics ?? {};
      const rows = laps.map(lap => {
        const stats = samples.get(lap.index) ?? {};
        const values = [lap.index, lap.distance_m, lap.active_seconds, lap.pace_seconds_per_km, lap.avg_hr, lap.max_hr,
          lap.avg_power_w, lap.ascent_m, lap.descent_m, ...mechanics.map(field => stats.mechanics?.[field]),
          stats.mechanics_paired_count, stats.record_count];
        return values.map(value => number(value) ? Number(fixed(value, 3)) : value ?? null);
      });
      const { alternative_tss: tss, intensity, summary, weather: _weather, suuntoplus_apps: apps, ...core } = cloud;
      return {
        cloud: { ...core, summary: select(summary, [
          'avgPower', 'maxPower', 'avgCadence', 'avgGroundContactTime', 'avgVerticalOscillation', 'pte', 'peakEpoc', 'feeling', 'recoveryTime',
        ]), hr_zones: intensity?.zones?.heartRate ?? null,
        alternative_tss: tss.map(item => select(item, ['calculationMethod', 'trainingStressScore', 'intensityFactor', 'normalizedPower'])),
        suuntoplus_apps: apps },
        lap_columns: columns, lap_rows: rows, recovery: workout.recovery ?? null,
        distance_blocks: workout.distance_blocks ?? distanceBlocks(laps, samples),
        pauses: fit.timer.pauses, hr_peak: fit.hr_peak, sample_counts: take(fit, sampleColumns),
        sample_method: details.method ?? null, active_statistics: details.active ?? null,
        recovery_hr: details.slower_next_lap_hr_changes ?? null, suuntoplus_channels: details.suuntoplus_channels ?? null,
        altitude_profile: details.altitude_profile ?? null, outputs: workout.outputs ?? null, files: workout.files,
      };
    }),
    comparison_candidates: candidates.map(row => take(row, ['workout_key', 'activity_id', 'start_local', 'distance_m',
      'active_seconds', 'pace_seconds_per_km', 'avg_hr_bpm', 'max_hr_bpm', 'ascent_m', 'tss'])),
  };
}
