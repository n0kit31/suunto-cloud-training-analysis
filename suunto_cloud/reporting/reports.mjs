import { lstat, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { chartSummary } from '../analysis/chart_summary.mjs';
import { number } from '../analysis/metrics.mjs';
import { recoveryContext } from '../analysis/sleep.mjs';
import { workoutHighlights } from '../analysis/workout_highlights.mjs';
import { comparisonWorkouts } from '../storage/comparison.mjs';
import { artifactTimestamp, cloudArtifactStem, privateJson, privateWrite, readOptionalJson } from '../storage/local.mjs';
import { readSleep } from '../storage/sleep.mjs';
import { workoutChart } from './chart_svg.mjs';
import { duration, fixed } from './format.mjs';
import { chartHtml } from './interactive.mjs';
import { recoveryMarkdown, workoutFeeling } from './recovery.mjs';
import { summaryHtml } from './summary.mjs';
import { postWorkoutHr, recoveryLabels } from './workout_tiles.mjs';

const startMarker = '<!-- suunto-generated:start -->';
const endMarker = '<!-- suunto-generated:end -->';
const chartMarker = '<!-- generated: suunto-analysis -->';
const display = (value, digits = 1) => value == null ? '—' : number(value) ? fixed(value, digits) : String(value);
const raw = value => value == null ? 'None' : String(value);

function chartExplanations(chart) {
  if (!chart) return [];
  return ['', `[Workout metric charts](${chart})`, '',
    'HR chart: centered 15 s moving average of available samples (±7.5 s), calculated separately for continuous measurement segments. ' +
    'Gaps >2 s and pauses separate windows. Gaps in the heart rate line are connected linearly on the chart only. ' +
    'HR values in tables and analysis come from source data.', '',
    'Pace chart: centered 15 s moving median. Elevation chart: centered 15 s moving average. ' +
    'Both reset at pauses and measurement gaps >2 s. Pace gaps are connected linearly on the chart only; elevation gaps remain visible. ' +
    'No source samples are added. Their axes use twice the smoothed min-max span around its midpoint, with minimum data spans of 0.5 min/km and 1 m. ' +
    'Pace bounds shift upward if needed to keep the lower limit nonnegative. Smoothing affects charts only.', '',
    'Additional charts are included only when their measurements exist. Power: 15 s mean and filled line. Speed: 15 s median in km/h and filled line. ' +
    'Cadence, ground contact and estimated step length: observed dots (reduced preserving extrema) with a 15 s median trend, no area fill. ' +
    'Their doubled axis ranges include the observed dots. Running/walking cadence is converted from cycles/min to steps/min; ' +
    'other cadence remains rpm. Ground contact is in ms. Estimated single step length = 30 * simultaneous speed (m/s) / cadence (cycles/min); ' +
    'missing or nonpositive speed/cadence pairs are omitted.', '',
    'Estimated terrain grade is 100 * rise/run across actual endpoint samples within ±25 m, requiring at least 20 m and three distinct distance observations, ' +
    'then a centered 15 s mean. Windows do not cross pauses, input gaps >2 s, missing elevation/distance, distance resets, or stationary stretches >2 s. ' +
    'It is a local estimate, not a surveyed gradient. Its doubled range includes zero; green/blue areas show uphill/downhill relative to zero. ' +
    'New chart gaps remain visible. Source measurements and workout statistics are unchanged.',
  ];
}

function reportBody(cloud, analysis, source, retrieved, chart, recovery) {
  const summary = cloud.summary;
  const details = analysis.additional_metrics;
  const feeling = workoutFeeling(summary.feeling).rating;
  const highlights = workoutHighlights(cloud, analysis);
  const zone = cloud.timezone || (/([+-]\d\d:\d\d)$/.exec(cloud.start_local) ? 'UTC' + cloud.start_local.slice(-6) : 'UTC');
  const local = source.source_type === 'local_fit';
  const provenance = local ? `Imported from local FIT: ${retrieved}; timezone ${zone}.` :
    `Retrieved: ${retrieved}; timezone ${zone}; ID \`${cloud.workout_key}\`.`;
  const lines = [provenance, '', '| Metric | Value |', '| --- | --- |',
    `| Distance | ${display(number(cloud.distance_m) ? cloud.distance_m / 1000 : null, 3)} km |`,
    `| Active / elapsed time | ${duration(cloud.active_seconds)} / ${duration(cloud.elapsed_seconds)} |`,
    `| Active pace | ${duration(cloud.pace_seconds_per_km)}/km |`,
    `| Average / maximum HR | ${raw(cloud.avg_hr_bpm)} / ${raw(cloud.max_hr_bpm)} |`,
    `| Ascent / descent | ${display(cloud.ascent_m)} / ${display(cloud.descent_m)} m |`,
    `| TSS | ${display(cloud.tss?.trainingStressScore, 3)}; ${raw(cloud.tss?.calculationMethod)} |`,
    `| PTE / estimated VO₂max | ${display(summary.pte)} / ${display(cloud.fitness?.estimatedVo2Max)} |`,
    `| Workout feeling | ${feeling === null ? '—' : feeling + '/5 (recorded after workout)'} |`];
  if (highlights.temperature_c !== null) lines.push(`| Average workout temperature | ${display(highlights.temperature_c)} °C (watch sensor) |`);
  const hr = postWorkoutHr(cloud);
  if (hr?.[1]) lines.push(`| Post-workout HR change (Suunto) | ${hr[0]} · ${hr[1]} |`);
  if (highlights.recovery_seconds !== null) {
    const [estimate, kind, until] = recoveryLabels(highlights);
    lines.push(`| Suunto recovery time | ${estimate} (${kind.toLowerCase()})${until ? ' · ' + until : ''} |`);
  }
  lines.push(...recoveryMarkdown(recovery), '', '## Laps and running mechanics', '',
    'One non-overlapping lap type was selected. Pace uses active time and distance; mechanics use available paired samples.', '',
    '| Lap | m | Time | Pace/km | Avg/max HR | W | +m/−m | Steps/min | Contact ms | Oscillation cm | Estimated step m |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const byIndex = new Map(analysis.laps.map(lap => [lap.index, lap]));
  for (const sample of details.lap_samples) {
    const lap = byIndex.get(sample.lap_index);
    const m = sample.mechanics ?? {};
    lines.push(`| ${lap.index} | ${raw(lap.distance_m)} | ${duration(lap.active_seconds)} | ${duration(lap.pace_seconds_per_km)} | ` +
      `${raw(lap.avg_hr)}/${raw(lap.max_hr)} | ${display(lap.avg_power_w, 0)} | ${display(lap.ascent_m)}/${display(lap.descent_m)} | ` +
      `${display(m.cadence_steps_per_min)} | ${display(m.ground_contact_ms)} | ${display(m.vertical_oscillation_cm, 2)} | ${display(m.estimated_step_length_m, 3)} |`);
  }
  lines.push('', '## Pauses and HR after slowing down', '');
  for (const pause of analysis.timer.pauses) {
    lines.push(`- ${pause.start}–${pause.end}: ${duration(pause.seconds)}; reason unknown.`);
  }
  if (!analysis.timer.pauses.length) lines.push('No pauses confirmed by timer events.');
  for (const step of details.slower_next_lap_hr_changes) {
    lines.push(`- Lap ${step.work_lap_index} → ${step.slower_next_lap_index}: HR drop after 60 s: ${display(step.hr_drop_after_60_seconds, 0)} bpm; ` +
      `pause in the next step: ${step.pause_in_next_lap ? 'True' : 'False'}. This is not a clinical HRR test.`);
  }
  lines.push('', '## Intensity and additional data', '');
  for (const [name, zone] of Object.entries(cloud.intensity?.zones?.heartRate ?? {})) {
    if (number(zone.totalTime)) lines.push(`- HR ${name}: ${duration(zone.totalTime)}; lower limit ${display(zone.lowerLimit, 0)} bpm.`);
  }
  const zoneSense = Object.entries(cloud.zone_sense?.zones ?? {});
  if (zoneSense.length) {
    lines.push('- ZoneSense (separate classification; no percentages of active time): ' +
      zoneSense.filter(([key, value]) => key.endsWith('Ms') && number(value)).map(([key, value]) => `${key}: ${duration(value / 1000)}`).join('; '));
  }
  for (const channel of details.suuntoplus_channels) {
    lines.push(`- SuuntoPlus ${channel.label}: unit \`${raw(channel.unit)}\`, ${channel.active_sample_count} active samples, last value ` +
      `${display(channel.last_active_value, 3)}, session result ${display(channel.session_value, 3)}.`);
  }
  lines.push('', 'Marathon time estimators project a finish time from pace; they do not measure maximum performance. ' +
    'Do not add TSS values calculated with different methods. Power thresholds, grade-adjusted pace units, ' +
    'missing ZoneSense thresholds, and R-R artifacts require separate assessment before interpretation.', '',
    details.method, '', 'Full data, sample counts, and additional fields are in the adjacent JSON file; ' +
    `original FIT: \`${source.fit_path}\`, SHA-256 \`${source.fit_sha256}\`.`, ...chartExplanations(chart));
  return lines.join('\n');
}

async function optionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function legacyMarkdown(path, workoutKey) {
  let report;
  try {
    report = await readOptionalJson(path);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return report?.cloud?.workout_key === workoutKey ? optionalText(path.replace(/\.json$/, '.md')) : null;
}

export async function writeOutputs(project, cloud, analysis, decoded, source, retrieved, {
  charts = false, hrRange = null, recovery = null, peers = [], reportPath = null,
} = {}) {
  const reports = join(project, 'reports');
  const legacyStem = artifactTimestamp(cloud.start_local);
  const local = source.source_type === 'local_fit';
  const key = cloud.workout_key;
  const stem = reportPath ? basename(reportPath, extname(reportPath)).replace(/^suunto-/, '') :
    local ? `${legacyStem}-fit-${source.fit_sha256.slice(0, 16)}` : key ? cloudArtifactStem(cloud.start_local, key) : legacyStem;
  const path = reportPath ?? join(reports, `suunto-${stem}.json`);
  const markdown = join(dirname(path), basename(path, extname(path)) + '.md');
  const chart = join(project, 'visualizations', basename(path, extname(path)) + '-overview.html');
  const svgPath = chart.replace(/\.html$/, '.svg');
  const context = charts ? chartSummary(cloud, analysis, peers) : null;
  const { svg, interaction } = charts ? workoutChart(decoded, analysis, cloud, hrRange, true, recovery) : {};
  const body = reportBody(cloud, analysis, source, retrieved, svg ? chart : null, recovery);
  const block = `${startMarker}\n${body}\n${endMarker}`;
  const legacy = join(reports, `suunto-${legacyStem}.json`);
  const previous = await optionalText(markdown) ??
    (!local && key && path !== legacy ? await legacyMarkdown(legacy, key) : null) ?? `# Workout ${stem}\n\n`;
  const start = previous.indexOf(startMarker);
  const end = previous.indexOf(endMarker, start + startMarker.length);
  const content = start !== -1 && end !== -1 ? previous.slice(0, start) + block + previous.slice(end + endMarker.length) :
    previous.trimEnd() + '\n\n' + block + '\n';
  if (svg) {
    await privateWrite(svgPath, svg);
    await privateWrite(chart, chartHtml(svg, interaction, basename(svgPath), summaryHtml(context)));
  }
  await privateWrite(markdown, content);
  await privateJson(path, { retrieved_at_utc: retrieved, cloud, fit: analysis, source, recovery,
    chart_path: svg ? chart : null, svg_path: svg ? svgPath : null, chart_summary: context });
  return { markdown_path: markdown, json_path: path, chart_path: svg ? chart : null, svg_path: svg ? svgPath : null };
}

async function restoreRecoveryTimes(cloud, source) {
  if (Object.hasOwn(cloud, 'cumulative_recovery_seconds') || !cloud.workout_key || !source.cloud_summary_path) return cloud;
  try {
    const raw = await readOptionalJson(source.cloud_summary_path);
    if (raw?.workoutKey === cloud.workout_key) return { ...cloud,
      cumulative_recovery_seconds: raw.cumulativeRecoveryTime ?? null, workout_recovery_seconds: raw.recoveryTime ?? null };
  } catch {
    // The saved cloud summary is optional when regenerating older reports.
  }
  return cloud;
}

export async function regenerateReport(reportPath, hrRange, sleepData) {
  const path = await realpath(reportPath);
  const project = dirname(dirname(path));
  const report = JSON.parse(await readFile(path, 'utf8'));
  const cloud = await restoreRecoveryTimes(report.cloud, report.source);
  const decoded = JSON.parse(await readFile(report.source.decoded_path, 'utf8'));
  const recovery = sleepData ? recoveryContext(cloud, await readSleep(sleepData, true)) : report.recovery ?? null;
  const peers = report.source.source_type === 'local_fit' ? [] : await comparisonWorkouts(project, cloud, report.chart_summary);
  const outputs = await writeOutputs(project, cloud, report.fit, decoded, report.source, report.retrieved_at_utc,
    { charts: true, hrRange, recovery, peers, reportPath: path });
  await pruneReportCharts(project, [outputs]);
  return outputs;
}

export async function pruneReportCharts(project, reports, now = Date.now()) {
  const keep = new Set(reports.flatMap(row => [row.chart_path, row.svg_path]));
  const directory = join(project, 'visualizations');
  const paths = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const removed = [];
  for (const name of paths.sort()) {
    const path = join(directory, name);
    if (!/^suunto-.*\.(svg|html|png)$/i.test(name) || keep.has(path)) continue;
    const info = await lstat(path);
    if (!info.isFile() || info.mtimeMs >= now - 30 * 86400000) continue;
    const file = await open(path);
    let owned;
    try {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await file.read(buffer);
      owned = buffer.subarray(0, bytesRead).includes(chartMarker);
    } finally {
      await file.close();
    }
    if (owned) {
      await unlink(path);
      removed.push(path);
    }
  }
  return removed;
}
