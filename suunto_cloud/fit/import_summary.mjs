import { activityLabel } from '../activities.mjs';
import { cloudMetrics } from '../analysis/cloud_metrics.mjs';
import { number } from '../analysis/metrics.mjs';
import { timestampMs } from '../timezones.mjs';

export function fitSummary(decoded, zone) {
  const [session] = decoded.sessions ?? [];
  if (decoded.sessions?.length !== 1 || !session.start_time) {
    throw new TypeError('Import requires a workout FIT with one session and a start time.');
  }
  const start = timestampMs(session.start_time);
  const stop = number(session.total_elapsed_time) ? start + session.total_elapsed_time * 1000 :
    session.timestamp ? timestampMs(session.timestamp) : null;
  return cloudMetrics({
    workoutKey: null, activityName: activityLabel({}, decoded),
    startTime: start, stopTime: stop, totalDistance: session.total_distance, totalTime: session.total_timer_time,
    totalAscent: session.total_ascent, totalDescent: session.total_descent, energyConsumption: session.total_calories,
    hrdata: { workoutAvgHR: session.avg_heart_rate, workoutMaxHR: session.max_heart_rate },
  }, zone);
}
