import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { activityLabel, footActivity } from './activities.mjs';
import { chartSummary } from './analysis/chart_summary.mjs';
import { summarizeFit } from './analysis/fit.mjs';
import { number } from './analysis/metrics.mjs';
import { cloudMetrics } from './analysis/cloud_metrics.mjs';
import { fitMaxBytes } from './downloads/cloud.mjs';
import decoder from './fit/decode.cjs';
import devices from './fit/device_model.cjs';
import { fitSummary } from './fit/import_summary.mjs';
import { workoutChart } from './reporting/chart_svg.mjs';
import { chartHtml } from './reporting/interactive.mjs';
import { summaryObservations } from './reporting/summary.mjs';
import { privateWrite } from './storage/local.mjs';
import { timestampMs } from './timezones.mjs';

const lapMetrics = {
  distanceM: 'distance_m', activeSeconds: 'active_seconds', elapsedSeconds: 'elapsed_seconds',
  paceSecondsPerKm: 'pace_seconds_per_km', avgHr: 'avg_hr', maxHr: 'max_hr', avgPowerW: 'avg_power_w',
  ascentM: 'ascent_m', descentM: 'descent_m',
};
const numeric = value => number(value) ? value : null;
const first = (...values) => values.find(number) ?? null;

export class AnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function summaryFields(cloud, decoded = {}) {
  const session = decoded.sessions?.[0] ?? {};
  return {
    startedAt: timestampMs(cloud.start_local), sport: activityLabel(cloud, decoded) ?? 'Activity',
    distanceM: first(cloud.distance_m, session.total_distance),
    activeSeconds: first(cloud.active_seconds, session.total_timer_time),
    avgHr: first(cloud.avg_hr_bpm, session.avg_heart_rate),
  };
}

function workoutMetrics(cloud, analysis, context, summary) {
  const { session, timer } = analysis;
  const foot = footActivity(cloud, session.sport);
  const cadence = numeric(session.avg_cadence);
  return {
    maxHr: first(cloud.max_hr_bpm, session.max_heart_rate),
    ascentM: first(cloud.ascent_m, session.total_ascent), descentM: first(cloud.descent_m, session.total_descent),
    elapsedSeconds: first(session.total_elapsed_time, cloud.elapsed_seconds),
    paceSecondsPerKm: summary.distanceM > 0 && summary.activeSeconds !== null
      ? summary.activeSeconds / (summary.distanceM / 1000) : null,
    avgPowerW: numeric(session.avg_power), maxPowerW: numeric(session.max_power),
    avgCadence: cadence === null ? null : cadence * (foot ? 2 : 1),
    cadenceUnit: cadence === null ? null : foot ? 'spm' : 'rpm',
    energyKcal: first(cloud.energy_kcal, session.total_calories),
    pauseSeconds: timer.active_segments.length ? numeric(timer.pause_seconds_from_rounded_events) : null,
    hrTss: numeric(context.workout.hr_tss), temperatureC: numeric(context.highlights.temperature_c),
    recoverySeconds: numeric(context.highlights.recovery_seconds),
    recordCount: analysis.record_count, activeHrSampleCount: analysis.active_hr_sample_count,
  };
}

export async function readFit(path) {
  const chunks = [];
  for await (const chunk of createReadStream(path, { end: fitMaxBytes })) chunks.push(chunk);
  const content = Buffer.concat(chunks);
  if (content.length > fitMaxBytes || content.length < 12 || content.toString('ascii', 8, 12) !== '.FIT') {
    throw new AnalysisError('INVALID_FIT', 'The input is not a FIT file within the 64 MiB limit.');
  }
  return content;
}

export async function analyzeFit(workspace, content, zone, cloudRecord = null, downloaded = Boolean(cloudRecord)) {
  await privateWrite(join(workspace, 'source.fit'), content);
  let decoded, cloud, analysis;
  try {
    decoded = decoder.decodeJson(content);
    cloud = cloudRecord ? cloudMetrics(cloudRecord, zone) : fitSummary(decoded, zone);
    analysis = summarizeFit(decoded, zone);
  } catch {
    if (downloaded) throw new AnalysisError('FIT_UNAVAILABLE', 'Suunto returned a FIT file that could not be analyzed.');
    throw new AnalysisError('INVALID_FIT', 'The FIT could not be analyzed. Local uploads require one workout session.');
  }
  const summary = summaryFields(cloud, decoded);
  const context = chartSummary(cloud, analysis);
  const { svg, interaction } = workoutChart(decoded, analysis, cloud);
  if (svg) await privateWrite(join(workspace, 'chart.html'), chartHtml(svg, interaction, 'workout.svg'));
  const preferred = new Set(analysis.additional_metrics.preferred_lap_indices);
  const laps = analysis.laps.filter(lap => preferred.has(lap.index)).map(lap => ({
    index: lap.index,
    ...Object.fromEntries(Object.entries(lapMetrics).map(([key, source]) => [key, numeric(lap[source])])),
  }));
  return {
    summary, metrics: workoutMetrics(cloud, analysis, context, summary), laps,
    observations: summaryObservations(context), fitSha256: createHash('sha256').update(content).digest('hex'),
    chart: Boolean(svg), deviceModel: devices.recordingDeviceModel(decoded),
  };
}
