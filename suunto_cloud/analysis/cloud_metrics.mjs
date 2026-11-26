import { localTimestamp } from '../timezones.mjs';

export function cloudMetrics(workout, zone) {
  const extensions = new Map((workout.extensions ?? []).map(item => [item.type, item]));
  const summary = extensions.get('SummaryExtension') ?? {};
  const excluded = new Set(['type', 'gear', 'additionalGears', 'exerciseId', 'apps', 'weather']);
  const distance = workout.totalDistance ?? null;
  const duration = workout.totalTime ?? null;
  const start = workout.startTime;
  const stop = workout.stopTime;
  const hr = workout.hrdata ?? {};
  return {
    workout_key: workout.workoutKey, activity_id: workout.activityId ?? null, activity_name: workout.activityName ?? null,
    timezone: zone || 'system local', start_local: localTimestamp(start, zone),
    stop_local: stop == null ? null : localTimestamp(stop, zone),
    distance_m: distance, active_seconds: duration, elapsed_seconds: stop == null ? null : (stop - start) / 1000,
    pace_seconds_per_km: distance && duration !== null ? duration / (distance / 1000) : null,
    avg_hr_bpm: hr.workoutAvgHR ?? null, max_hr_bpm: hr.workoutMaxHR ?? null,
    ascent_m: Object.hasOwn(summary, 'ascent') ? summary.ascent : (workout.totalAscent ?? null),
    descent_m: Object.hasOwn(summary, 'descent') ? summary.descent : (workout.totalDescent ?? null),
    steps: workout.stepCount ?? null, energy_kcal: workout.energyConsumption ?? null,
    cumulative_recovery_seconds: workout.cumulativeRecoveryTime ?? null, workout_recovery_seconds: workout.recoveryTime ?? null,
    tss: workout.tss ?? null, alternative_tss: workout.tssList ?? [], tags: workout.suuntoTags ?? [],
    summary: Object.fromEntries(Object.entries(summary).filter(([key, value]) => value !== null && !excluded.has(key))),
    fitness: extensions.get('FitnessExtension') ?? null, intensity: extensions.get('IntensityExtension') ?? null,
    weather: extensions.get('WeatherExtension') ?? null, suuntoplus_apps: summary.apps ?? [],
    zone_sense: workout.zoneSense ?? null, rankings: workout.rankings ?? null,
  };
}
