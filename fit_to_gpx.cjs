#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function loadParser() {
  try { return require('fit-file-parser').default; } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(extensions)) {
    const editors = fs.readdirSync(extensions)
      .filter(name => name.startsWith('suunto.suuntoplus-editor-'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const editor of editors) {
      const modulePath = path.join(extensions, editor, 'node_modules', 'fit-file-parser');
      if (fs.existsSync(modulePath)) return require(modulePath).default;
    }
  }
  throw new Error('Brak fit-file-parser. Wymagany jest zainstalowany SuuntoPlus Editor lub lokalny pakiet fit-file-parser.');
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function timestamp(value) {
  if (value === null || value === undefined) return NaN;
  return new Date(value).getTime();
}

function trackFromRecords(data, name) {
  const records = data.records || [];
  const resumes = [];
  let paused = false;
  for (const event of [...(data.events || [])].sort((a, b) => timestamp(a.timestamp) - timestamp(b.timestamp))) {
    if (event.event !== 'timer') continue;
    if (['stop', 'stop_all', 'stop_disable', 'stop_disable_all'].includes(event.event_type)) paused = true;
    if (event.event_type === 'start') {
      if (paused && Number.isFinite(timestamp(event.timestamp))) resumes.push(timestamp(event.timestamp));
      paused = false;
    }
  }
  const segments = [];
  let current = [];
  let resumeIndex = 0;
  let skipped = 0;
  for (const record of records) {
    const lat = record.position_lat;
    const lon = record.position_long;
    const time = timestamp(record.timestamp);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(time)) {
      skipped++;
      continue;
    }
    let resumed = false;
    while (resumeIndex < resumes.length && time >= resumes[resumeIndex]) {
      resumeIndex++;
      resumed = true;
    }
    if (resumed && current.length) {
      segments.push(current);
      current = [];
    }
    const altitude = Number.isFinite(record.enhanced_altitude) ? record.enhanced_altitude : record.altitude;
    current.push({ lat, lon, time, altitude });
  }
  if (current.length) segments.push(current);
  const points = segments.flat();
  if (!points.length) throw new Error('FIT nie zawiera prawidłowych punktów GPS z czasem. Nie utworzono GPX.');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Suunto Cloud local export" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <trk><name>${xml(name)}</name>`,
  ];
  for (const segment of segments) {
    lines.push('    <trkseg>');
    for (const point of segment) {
      lines.push(`      <trkpt lat="${point.lat}" lon="${point.lon}">`);
      if (Number.isFinite(point.altitude)) lines.push(`        <ele>${point.altitude}</ele>`);
      lines.push(`        <time>${new Date(point.time).toISOString()}</time>`, '      </trkpt>');
    }
    lines.push('    </trkseg>');
  }
  lines.push('  </trk>', '</gpx>', '');
  return {
    gpx: lines.join('\n'),
    summary: {
      record_count: records.length,
      gps_point_count: points.length,
      segment_count: segments.length,
      records_without_valid_gps_or_time: skipped,
      first_gps_time_utc: new Date(points[0].time).toISOString(),
      last_gps_time_utc: new Date(points[points.length - 1].time).toISOString(),
    },
  };
}

function privateWrite(destination, content) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function convert(input, output) {
  if (path.resolve(input) === path.resolve(output)) throw new Error('Plik wejściowy i wyjściowy muszą być różne.');
  const FitParser = loadParser();
  const parser = new FitParser({ force: false, mode: 'list', lengthUnit: 'm', speedUnit: 'm/s' });
  const data = await new Promise((resolve, reject) => parser.parse(fs.readFileSync(input), (error, result) => error ? reject(new Error(String(error))) : resolve(result)));
  const result = trackFromRecords(data, path.basename(input, path.extname(input)));
  privateWrite(output, result.gpx);
  privateWrite(output.replace(/\.gpx$/i, '') + '.summary.json', JSON.stringify(result.summary, null, 2) + '\n');
  return result.summary;
}

module.exports = { trackFromRecords, convert, loadParser, privateWrite };

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write('Użycie: node fit_to_gpx.cjs trening.fit trasa.gpx\n');
    process.exitCode = 1;
  } else {
    convert(input, output).then(summary => {
      process.stdout.write(`Zapisano GPX: ${output}\nPunkty GPS: ${summary.gps_point_count}; segmenty: ${summary.segment_count}\n`);
    }).catch(error => {
      process.stderr.write(`Błąd konwersji FIT: ${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
