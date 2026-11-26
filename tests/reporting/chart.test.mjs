import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { summarizeFit } from '../../suunto_cloud/analysis/fit.mjs';
import { interactionPayload, prepareChart } from '../../suunto_cloud/reporting/chart_model.mjs';
import { chartHtml } from '../../suunto_cloud/reporting/interactive.mjs';
import { fileURLToPath } from 'node:url';

test('workout chart produces the recorded v1.4.0 timeline and readouts', async () => {
  const expected = JSON.parse(await readFile(new URL('../baselines/web-fit-import-v1.4.0.json', import.meta.url))).chartData;
  const at = seconds => new Date(Date.parse('2021-09-08T01:46:40Z') + seconds * 1000).toISOString();
  const decoded = {
    sessions: [{ sport: 'running' }],
    events: [
      { event: 'timer', event_type: 'start', timestamp: at(0) },
      { event: 'timer', event_type: 'stop', timestamp: at(60) },
    ],
    records: Array.from({ length: 61 }, (_, second) => ({
      timestamp: at(second), heart_rate: 130 + second % 10, distance: second * 3, speed: 3,
    })),
  };
  const cloud = {
    activity_name: 'Running', start_local: '2021-09-08T03:46:40+02:00', stop_local: '2021-09-08T03:47:40+02:00',
  };
  const chart = prepareChart(decoded, summarizeFit(decoded), cloud, null, true);
  assert.deepEqual(interactionPayload(chart, 0), {
    ...expected, title: expected.title.replace(' · Suunto Race 2', ''),
  });
});

test('chart HTML prevents data from closing a script element', () => {
  const name = 'Run </script><script>alert(1)</script>';
  const html = chartHtml('<svg/>', { title: name, total_seconds: 60, laps: [] }, 'test.svg');
  const data = html.split('<script id="chart-data" type="application/json">')[1].split('</script>')[0];
  assert.equal(JSON.parse(data).title, name);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('interactive chart still handles dragging, pinning and switching laps with scaled SVG coordinates', () => {
  const harness = fileURLToPath(new URL('./interactive_harness.cjs', import.meta.url));
  const result = spawnSync(process.execPath, [harness], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cursor and zoom checks passed/);
});
