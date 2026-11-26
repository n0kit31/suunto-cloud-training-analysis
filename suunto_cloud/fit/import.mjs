import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { summarizeFit } from '../analysis/fit.mjs';
import { writeOutputs } from '../reporting/reports.mjs';
import { privateDirectory, privateJson, root } from '../storage/local.mjs';
import { localTimestamp } from '../timezones.mjs';
import decoder from './decode.cjs';
import { fitSummary } from './import_summary.mjs';

export async function importFit(input, zone, charts) {
  const path = await realpath(input);
  const content = await readFile(path);
  const decoded = decoder.decodeJson(content);
  const cloud = fitSummary(decoded, zone);
  const analysis = summarizeFit(decoded, zone);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const decodedPath = join(await privateDirectory(), 'tracks', `fit-${sha256}.decoded.json`);
  await privateJson(decodedPath, decoded);
  const source = { fit_path: path, fit_sha256: sha256, decoded_path: decodedPath, source_type: 'local_fit' };
  return writeOutputs(dirname(root), cloud, analysis, decoded, source, localTimestamp(Date.now(), 'UTC'), { charts });
}
