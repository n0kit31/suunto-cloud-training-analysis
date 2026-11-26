import { localTimestamp, timestampMs } from '../timezones.mjs';
import { number } from './metrics.mjs';

export const celsiusFromKelvin = value => number(value) && value > 0 ? value - 273.15 : null;

export function workoutHighlights(cloud, analysis) {
  const summary = cloud.summary ?? {};
  const session = analysis.session ?? {};
  const temperature = celsiusFromKelvin(summary.avgTemperature) ??
    (number(session.avg_temperature) ? session.avg_temperature : null);
  const [seconds, kind] = [
    [cloud.cumulative_recovery_seconds, 'cumulative'], [cloud.workout_recovery_seconds, 'workout'],
    [summary.recoveryTime, 'workout'], [session.recovery_time, 'workout'],
  ].find(([value]) => number(value) && 0 <= value && value <= 315360000) ?? [null, null];
  let until = null;
  if (seconds !== null && cloud.stop_local) {
    const offset = /(?:[+-]\d\d:\d\d(?::\d\d)?|Z)$/.exec(cloud.stop_local)?.[0];
    if (offset) {
      const time = timestampMs(cloud.stop_local) + seconds * 1000;
      const zone = cloud.timezone !== 'system local' && cloud.timezone ? cloud.timezone : undefined;
      if (zone) until = localTimestamp(time, zone);
      else {
        const sign = offset.startsWith('-') ? -1 : 1;
        const [hours = 0, minutes = 0, extra = 0] = offset.slice(1).split(':').filter(Boolean).map(Number);
        const local = new Date(time + sign * (hours * 3600 + minutes * 60 + extra) * 1000).toISOString();
        until = local.replace(/(?:\.000)?Z$/, offset === 'Z' ? '+00:00' : offset)
          .replace(/\.(\d{3})(?=[+-])/, (_match, digits) => `.${digits}000`);
      }
    }
  }
  return { temperature_c: temperature, recovery_seconds: seconds, recovery_kind: kind, recovery_until: until };
}
