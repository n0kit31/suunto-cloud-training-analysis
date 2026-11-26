import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AccessError, authorizedCall, safeError } from '../authentication/access.mjs';
import { cloudMetrics } from '../analysis/cloud_metrics.mjs';
import { summarizeFit } from '../analysis/fit.mjs';
import { briefPacket, buildPacket } from '../analysis/packet.mjs';
import { recoveryContext } from '../analysis/sleep.mjs';
import { chooseWorkout, dateCutoff, fetchFit, fetchWorkouts, paginatedWorkouts } from '../downloads/cloud.mjs';
import decoder from '../fit/decode.cjs';
import { fixed } from '../reporting/format.mjs';
import { pruneReportCharts, writeOutputs } from '../reporting/reports.mjs';
import { FileLockError, cloudArtifactStem, privateDirectory, privateJson, privateWrite, root, withFileLock } from '../storage/local.mjs';
import { readSleep } from '../storage/sleep.mjs';
import { localTimestamp } from '../timezones.mjs';

const timing = start => Number(fixed((performance.now() - start) / 1000, 4));

async function publishAnalysis(directory, manifestPath, manifest, records, analyses, zone, sleep, charts) {
  let stage = 'report_context';
  try {
    const byKey = new Map(records.map(row => [row.workoutKey, row]));
    const peers = charts ? records.map(row => cloudMetrics(row, zone)) : [];
    stage = 'report';
    for (const entry of manifest.workouts) {
      const started = performance.now();
      try {
        const key = entry.workout_key;
        const cloud = cloudMetrics(byKey.get(key), zone);
        entry.recovery = recoveryContext(cloud, sleep);
        const decoded = JSON.parse(await readFile(entry.decoded_path, 'utf8'));
        entry.outputs = await writeOutputs(dirname(root), cloud, analyses.get(key), decoded, entry, manifest.retrieved_at_utc,
          { charts, recovery: entry.recovery, peers });
      } catch (error) {
        Object.assign(entry, { failed_stage: stage, error: safeError(error) });
        throw error;
      }
      entry.timings_seconds.outputs = timing(started);
      await privateJson(manifestPath, manifest);
    }
    stage = 'chart_cleanup';
    manifest.removed_old_charts = charts ? await pruneReportCharts(dirname(root), manifest.workouts.map(entry => entry.outputs)) : [];
    stage = 'analysis_packet';
    const packet = buildPacket({ ...manifest, complete: true }, records, analyses, zone);
    manifest.analysis_packet_path = await privateJson(join(directory, 'analysis.json'), packet);
    return packet;
  } catch (error) {
    Object.assign(manifest, { failed_stage: stage, error: safeError(error) });
    throw new AccessError(`Synchronization failed during ${stage}. Details saved to .local/sync.json.`);
  }
}

async function synchronize(directory, dates, { decode, analysis, brief, charts, zone, sleep }) {
  const started = performance.now();
  const progress = message => { if (!analysis) console.log(message); };
  const wanted = new Set(dates);
  const first = new Date([...wanted].sort()[0] + 'T00:00:00Z');
  const monday = new Date(first.getTime() - (first.getUTCDay() + 6) % 7 * 86400000).toISOString().slice(0, 10);
  const data = await paginatedWorkouts(query => authorizedCall((token, key) => fetchWorkouts(token, key, query)), dateCutoff(monday, zone));
  const records = data.payload;
  await privateJson(join(directory, 'workouts.json'), data);
  const selected = records.map(row => [localTimestamp(row.startTime, zone), row]).filter(([start]) => wanted.has(start.slice(0, 10)));
  const found = new Set(selected.map(([start]) => start.slice(0, 10)));
  const missing = [...wanted].filter(day => !found.has(day)).sort();
  const manifest = {
    retrieved_at_utc: localTimestamp(Date.now(), 'UTC'), requested_dates: [...dates].sort(), timezone: zone || 'system local',
    workout_list_pages: data.metadata.pages, missing_dates: missing, workouts: [], complete: false,
    timings_seconds: { list: timing(started) },
  };
  const manifestPath = join(directory, 'sync.json');
  await privateJson(manifestPath, manifest);
  if (!selected.length) {
    throw new AccessError('No workouts for the requested dates in the fresh API response. Cached data was not substituted.');
  }
  let failed = false;
  const analyses = new Map();
  for (const [start, workout] of selected.sort(([, a], [, b]) => a.startTime - b.startTime)) {
    const key = workout.workoutKey;
    const entry = { workout_key: key, date: start.slice(0, 10), fit_downloaded: false, decoded: false };
    manifest.workouts.push(entry);
    let stage = 'cloud_summary';
    try {
      chooseWorkout([workout], null, key);
      entry.cloud_summary_path = await privateJson(join(directory, 'workouts', key + '.json'), workout);
      await privateJson(manifestPath, manifest);
      const base = join(directory, 'tracks', cloudArtifactStem(start, key));
      stage = 'fit_download';
      progress(`Downloading FIT: ${entry.date}, ${fixed((workout.totalDistance ?? 0) / 1000, 3)} km...`);
      const downloadStart = performance.now();
      const content = await authorizedCall((token, subscription) => fetchFit(key, token, subscription));
      await privateWrite(base + '.fit', content);
      Object.assign(entry, { fit_path: base + '.fit', fit_downloaded: true, fit_bytes: content.length,
        fit_sha256: createHash('sha256').update(content).digest('hex'), timings_seconds: { fit_download: timing(downloadStart) } });
      if (decode) {
        stage = 'decode';
        const decodeStart = performance.now();
        const decoded = decoder.decodeJson(content);
        entry.decoded_path = await privateJson(base + '.decoded.json', decoded);
        entry.decoded = true;
        entry.timings_seconds.decode = timing(decodeStart);
        if (analysis) {
          stage = 'analysis';
          const analysisStart = performance.now();
          let result;
          try {
            result = summarizeFit(decoded, zone);
          } catch {
            throw new AccessError('FIT decoded, but data required for analysis is missing.');
          }
          analyses.set(key, result);
          entry.analysis_path = await privateJson(base + '.analysis.json', result);
          entry.analyzed = true;
          entry.timings_seconds.analysis = timing(analysisStart);
        }
      }
      progress(`Saved FIT${decode ? ' and full JSON samples' : ''}: ${entry.date}.`);
    } catch (error) {
      Object.assign(entry, { failed_stage: stage, error: safeError(error) });
      failed = true;
      console.error(entry.error);
    } finally {
      await privateJson(manifestPath, manifest);
    }
  }
  let packet = null;
  try {
    if (!failed && !missing.length) {
      if (analysis) packet = await publishAnalysis(directory, manifestPath, manifest, records, analyses, zone, sleep, charts);
      manifest.complete = true;
    }
  } finally {
    manifest.timings_seconds.total = timing(started);
    await privateJson(manifestPath, manifest);
  }
  if (missing.length) console.error('Requested dates missing from the current API response: ' + missing.join(', '));
  if (!manifest.complete) throw new AccessError('Synchronization incomplete. Details saved to .local/sync.json.');
  if (packet) console.log(JSON.stringify(brief ? briefPacket(packet) : packet));
  else progress(`Completed: ${selected.length} activities. Manifest: ${manifestPath}`);
  return manifest;
}

export async function sync(dates, { decode = true, analysis = false, brief = false, charts = false, zone, sleepData } = {}) {
  if (analysis && !decode) throw new TypeError('--analysis requires FIT decoding; remove --no-decode.');
  if (brief && !analysis) throw new TypeError('--brief requires --analysis.');
  if (charts && !analysis) throw new TypeError('--charts requires --analysis.');
  if (sleepData && !analysis) throw new TypeError('--sleep-data requires --analysis.');
  const directory = await privateDirectory();
  const sleep = analysis ? await readSleep(sleepData ?? join(directory, 'sleep.json'), Boolean(sleepData)) : null;
  try {
    return await withFileLock(join(directory, 'sync.lock'),
      () => synchronize(directory, dates, { decode, analysis, brief, charts, zone, sleep }), false);
  } catch (error) {
    if (error instanceof FileLockError) throw new AccessError('Another sync is already running for this project.');
    throw error;
  }
}
