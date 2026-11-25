'use strict';

const { readFileSync } = require('node:fs');
const { decodeBuffer } = require('./decode.cjs');
const { trackSegments } = require('./export_gpx.cjs');

function activeClock(events = []) {
  const timer = events.filter(event => event.event === 'timer')
    .map(event => [Date.parse(event.timestamp), event.event_type])
    .filter(([time]) => Number.isFinite(time))
    .sort(([a], [b]) => a - b);
  const intervals = [];
  let start = null;
  let elapsed = 0;
  for (const [time, type] of timer) {
    if (type === 'start') start ??= time;
    if (start !== null && ['stop', 'stop_all', 'stop_disable', 'stop_disable_all'].includes(type)) {
      intervals.push({ start, end: time, elapsed });
      elapsed += time - start;
      start = null;
    }
  }
  return (time) => {
    let lo = 0, hi = intervals.length;
    while (lo < hi) {
      const middle = (lo + hi) >>> 1;
      if (intervals[middle].start <= time) lo = middle + 1;
      else hi = middle;
    }
    const interval = intervals[lo - 1];
    return interval && time <= interval.end ? (interval.elapsed + time - interval.start) / 1000 : null;
  };
}

function previewRoute(decoded, geographic = false) {
  const { segments } = trackSegments(decoded);
  const count = segments.reduce((total, segment) => total + segment.length, 0);
  if (count < 2) return null;

  // Unwrap longitude before projecting, so crossing the date line is continuous.
  const origin = segments[0][0];
  const longitudeScale = Math.cos(origin.lat * Math.PI / 180);
  const stride = Math.ceil((count - 1) / 3999);
  const activeTime = geographic ? activeClock(decoded.events) : null;
  let previousLongitude = origin.lon;
  let longitude = 0;
  let index = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const projected = [];
  for (const segment of segments) {
    const line = [];
    for (const { lat, lon, time } of segment) {
      longitude += ((lon - previousLongitude + 540) % 360) - 180;
      previousLongitude = lon;
      const x = longitude * longitudeScale;
      const y = origin.lat - lat;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (index % stride === 0 || index === count - 1) {
        line.push(activeTime ? [lat, Number((origin.lon + longitude).toFixed(7)), activeTime(time)] : [x, y]);
      }
      index++;
    }
    if (line.length) projected.push(line);
  }

  if (maxX === minX && maxY === minY) return null;
  if (geographic) return projected;
  const scale = Math.min(744 / (maxX - minX), 304 / (maxY - minY));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return projected.map((line) => line.map(([x, y]) => [
    Math.round(400 + (x - centerX) * scale),
    Math.round(180 + (y - centerY) * scale),
  ]));
}

module.exports = { previewRoute };

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(previewRoute(decodeBuffer(readFileSync(process.argv[2])), process.argv[3] === 'map')));
  } catch {
    process.exitCode = 1;
  }
}
