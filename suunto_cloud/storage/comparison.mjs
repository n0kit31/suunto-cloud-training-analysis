import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloudMetrics } from '../analysis/cloud_metrics.mjs';
import { workoutRecords } from '../downloads/cloud.mjs';
import { isObject, readOptionalJson } from './local.mjs';

export async function comparisonWorkouts(project, cloud, previous) {
  const rows = [...(previous?.week?.sessions ?? [])];
  const day = new Date(cloud.start_local.slice(0, 10) + 'T00:00:00Z');
  const start = day.getTime() - (day.getUTCDay() + 6) % 7 * 86400000;
  const dates = new Set(Array.from({ length: 7 }, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10)));
  const directory = join(project, 'reports');
  const paths = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const path of paths.sort()) {
    if (!/^suunto-\d{4}-\d\d-\d\d-\d{6}(?:-cloud-.*)?\.json$/.test(path) || !dates.has(path.slice(7, 17))) continue;
    try {
      const report = JSON.parse(await readFile(join(directory, path), 'utf8'));
      if (isObject(report?.cloud)) rows.push(report.cloud);
    } catch {
      // Malformed optional summaries must not prevent chart regeneration.
    }
  }
  try {
    const cached = await readOptionalJson(join(project, 'suunto-cloud', '.local', 'workouts.json'));
    const zone = cloud.timezone && cloud.timezone !== 'system local' ? cloud.timezone : undefined;
    if (cached !== undefined) {
      for (const record of workoutRecords(cached)) {
        try {
          rows.push(cloudMetrics(record, zone));
        } catch {
          // One malformed workout does not invalidate the other comparisons.
        }
      }
    }
  } catch {
    // Saved summaries are still useful if the optional cloud list is unavailable.
  }
  return rows;
}
