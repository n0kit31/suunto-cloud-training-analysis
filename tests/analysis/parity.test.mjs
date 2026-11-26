import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chartSummary } from '../../suunto_cloud/analysis/chart_summary.mjs';
import { cloudMetrics } from '../../suunto_cloud/analysis/cloud_metrics.mjs';
import { summarizeFit } from '../../suunto_cloud/analysis/fit.mjs';
import { workoutChart } from '../../suunto_cloud/reporting/chart_svg.mjs';
import { summaryObservations } from '../../suunto_cloud/reporting/summary.mjs';
import { summaryFields } from '../../suunto_cloud/web_analysis.mjs';
import { decodedCases } from '../support/parity.mjs';

const baseline = JSON.parse(readFileSync(new URL('../baselines/decoded-fit-v1.4.0.json', import.meta.url)));

// The complete chart model has thousands of points. Canonicalizing by object
// key preserves their order and lets the fixture record a compact fingerprint.
function chartFingerprint(chart) {
  const canonical = JSON.stringify(chart, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return createHash('sha256').update(canonical).digest('hex');
}

for (const [name, { decoded, cloud: source, zone }] of Object.entries(decodedCases())) {
  test(`v1.4.0 parity for synthetic ${name} FIT data`, () => {
    const expected = baseline[name];
    const analysis = summarizeFit(decoded, zone);
    const cloud = cloudMetrics(source, zone);
    const chart = workoutChart(decoded, analysis, cloud)?.interaction ?? null;
    assert.deepEqual(analysis, expected.analysis);
    assert.deepEqual(summaryFields(cloud, decoded), expected.summary);
    assert.deepEqual(summaryObservations(chartSummary(cloud, analysis)), expected.observations);
    assert.equal(chartFingerprint(chart), expected.chartSha256);
  });
}
