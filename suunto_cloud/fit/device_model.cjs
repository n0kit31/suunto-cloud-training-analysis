'use strict';

const { readFileSync, statSync } = require('node:fs');
const { decodeBuffer } = require('./decode.cjs');

// The Suunto product identifiers supported by the Python analyzer in 1.4.0.
const suuntoModels = new Map([
  [22, 'Suunto Ambit3 Peak'], [28, 'Suunto Spartan Sport'], [29, 'Suunto Spartan Ultra'],
  [34, 'Suunto 9 Baro'], [35, 'Suunto 9'], [36, 'Suunto 5'], [40, 'Suunto 7'],
  [42, 'Suunto 9 Peak'], [56, 'Suunto 5 Peak'], [67, 'Suunto Vertical 2'],
]);

function recordingDeviceModel(decoded) {
  const creators = (decoded.file_ids ?? []).filter(entry => entry.type === 'activity' || entry.type === 4);
  const onboard = (decoded.device_infos ?? []).filter(entry => entry.device_index === 0 || entry.device_index === 'creator');
  for (const entry of [...creators, ...onboard]) {
    if (typeof entry.product_name === 'string') {
      // Match Python's strip/isprintable rules, including Unicode separators.
      const model = entry.product_name.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, '');
      if (model && [...model].length <= 80 && !/\p{C}|(?! )\p{Z}/u.test(model)) return model;
    }
    if (entry.manufacturer === 23 || entry.manufacturer === 'suunto') {
      const model = suuntoModels.get(entry.product);
      if (model) return model;
    }
  }
  return null;
}

function readDeviceModel(path) {
  let info;
  try {
    info = statSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (error.code === 'ENOTDIR' || error.code === 'ELOOP') return null;
    throw error;
  }
  return info?.isFile() ? recordingDeviceModel(decodeBuffer(readFileSync(path))) : null;
}

module.exports = { recordingDeviceModel, readDeviceModel };

if (require.main === module) {
  try {
    const deviceModel = readDeviceModel(process.argv[2]);
    process.stdout.write(JSON.stringify({ deviceModel }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({
      error: { code: 'ANALYSIS_FAILED', message: 'The workout operation could not be completed.' },
    }) + '\n');
    process.exitCode = 1;
  }
}
