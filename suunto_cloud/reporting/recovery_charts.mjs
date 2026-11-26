import { deviationStatus } from '../analysis/sleep.mjs';
import { escape, fixed } from './format.mjs';

export const statusColors = {
  green: ['#e8f5eb', '#226b3c', '#c5e2cd', 'Within reference'],
  yellow: ['#fff4d2', '#886000', '#edd489', 'Outside reference'],
  red: ['#fde8e8', '#a22e36', '#efbec2', 'Large deviation'],
  unknown: ['#f3f6f8', '#526170', '#dce2e7', 'No comparison'],
  reference: ['#f3f6f8', '#526170', '#dce2e7', 'Reference only'],
};
const stages = [['deep', 'Deep', '#4b57a9'], ['light', 'Light', '#8d9ce8'], ['rem', 'REM', '#bd75c4']];
const unclassified = ['unknown', 'Stage breakdown unavailable', '#cad2da'];
const two = value => fixed(value, 2);
const dayMs = 86400000;

function slots(context) {
  const result = (context.nights_7d ?? []).map(row => ({ ...row, after: false }));
  if (result.length && context.after) {
    const last = Date.parse(result.at(-1).wake_date);
    const end = Date.parse(context.after.wake_date);
    for (let date = last + dayMs; end - last <= 3 * dayMs && date <= end; date += dayMs) {
      result.push({ wake_date: new Date(date).toISOString().slice(0, 10),
        sleep: date === end ? context.after : null, after: date === end });
    }
  }
  return result;
}

function grid(low, high, y, left, right) {
  return Array.from({ length: 5 }, (_, tick) => {
    const value = low + tick * (high - low) / 4;
    return `<line x1="${left}" x2="${right}" y1="${two(y(value))}" y2="${two(y(value))}" stroke="#dce1e6"/>\n` +
      `<text x="73" y="${two(y(value) + 5)}" font-size="14" text-anchor="end">${value}</text>`;
  });
}

function hrvHistory(nights, context, position) {
  const { x, left, right, width, pitch, selected } = position;
  const reference = context.references?.hrv_ms;
  const average = context.hrv_7d.average_ms;
  const observed = nights.map(row => row.sleep?.hrv_ms).filter(value => value != null);
  const values = [...observed, ...(average == null ? [] : [average]), ...(reference ? [reference.low, reference.high] : [])];
  const out = ['<g data-section="hrv-history">', '<text x="85" y="346" font-size="19">Nightly HRV · last 7 nights</text>'];
  if (reference) out.push('<rect x="85" y="361" width="14" height="12" fill="#d9eddf"/>',
    '<text x="106" y="372" font-size="13">60-day reference</text>');
  if (average != null) out.push('<line x1="330" x2="353" y1="367" y2="367" stroke="#33718f" stroke-dasharray="5 3"/>',
    `<text x="360" y="372" font-size="13">7-day mean: ${fixed(average, 1)} ms</text>`);
  out.push('<circle cx="691" cy="367" r="5" fill="#17212b"/>', '<text x="704" y="372" font-size="13">Before workout</text>');
  if (nights.some(row => row.after)) out.push('<circle cx="935" cy="367" r="5" fill="white" stroke="#788795" stroke-width="2"/>',
    '<text x="948" y="372" font-size="13">After workout</text>');
  if (values.length) {
    const minimum = Math.min(...values), maximum = Math.max(...values);
    const padding = Math.max(5, (maximum - minimum) * .15);
    const low = Math.max(0, Math.floor((minimum - padding) / 10) * 10);
    const high = Math.max(low + 10, Math.ceil((maximum + padding) / 10) * 10);
    const y = value => 395 + (high - value) / (high - low) * 155;
    if (reference) out.push(`<rect data-role="hrv-reference-band" x="${left}" y="${two(y(reference.high))}" width="${width}" height="${two(y(reference.low) - y(reference.high))}" fill="#d9eddf"/>`);
    out.push(...grid(low, high, y, left, right), '<text x="45" y="388" font-size="13">ms</text>');
    if (average != null) out.push(`<line data-role="hrv-7d-mean" x1="${left}" x2="${right}" y1="${two(y(average))}" y2="${two(y(average))}" stroke="#33718f" stroke-dasharray="6 4"/>`);
    let previous = null;
    nights.forEach((row, index) => {
      const value = row.sleep?.hrv_ms;
      if (value == null || row.after) previous = null;
      if (value == null) return;
      if (previous) out.push(`<line data-role="hrv-daily-line" x1="${two(previous[0])}" y1="${two(previous[1])}" x2="${two(x(index))}" y2="${two(y(value))}" stroke="#738796" stroke-width="1.8"/>`);
      if (!row.after) previous = [x(index), y(value)];
    });
    nights.forEach((row, index) => {
      const value = row.sleep?.hrv_ms;
      if (value == null) return;
      const before = selected(row);
      const color = row.after ? '#788795' : statusColors[deviationStatus(value, reference)][1];
      const role = row.after ? 'after-workout' : before ? 'selected-night' : 'night';
      out.push(`<circle data-role="${role}" data-value="${escape(value)}" cx="${two(x(index))}" cy="${two(y(value))}" r="${before ? 7 : 5}" fill="${row.after ? 'white' : color}" stroke="${before ? '#17212b' : color}" stroke-width="2"><title>${escape(row.wake_date)}: ${escape(value)} ms</title></circle>`);
      if (before || row.after) {
        out.push(`<text x="${two(x(index))}" y="${two(y(value) - 15)}" font-size="14" text-anchor="middle" font-weight="bold" fill="${color}">${row.after ? 'After: ' : ''}${escape(value)}</text>`);
      }
    });
  } else {
    out.push('<text x="85" y="460" font-size="16" fill="#526170">No nightly HRV samples in this window.</text>');
  }
  const spo2 = nights.some(row => row.sleep?.spo2_max_pct != null);
  nights.forEach((row, index) => {
    out.push(`<text x="${two(x(index))}" y="574" font-size="14" text-anchor="middle" font-weight="${selected(row) ? 'bold' : 'normal'}">${escape(row.wake_date.slice(5))}</text>`);
    if (row.after) {
      const divider = two(left + index * pitch);
      out.push(`<line data-role="after-workout-divider" x1="${divider}" x2="${divider}" y1="390" y2="${spo2 ? 604 : 550}" stroke="#a2adb7" stroke-dasharray="4 4"/>`);
    }
  });
  if (spo2) {
    out.push('<g data-section="spo2-history" fill="#526170" font-size="13">',
      '<title>Highest overnight SpO₂ by wake date</title>', '<text x="74" y="598" text-anchor="end">SpO₂ max</text>');
    nights.forEach((row, index) => {
      const label = row.sleep?.spo2_max_pct == null ? '—' : fixed(row.sleep.spo2_max_pct, 1) + '%';
      out.push(`<text data-wake-date="${escape(row.wake_date)}" x="${two(x(index))}" y="598" text-anchor="middle">${label}</text>`);
    });
    out.push('</g>');
  }
  out.push(`<text x="622.5" y="${spo2 ? 620 : 598}" font-size="14" text-anchor="middle">Wake date · workout local time</text>`,
    `<text x="85" y="${spo2 ? 640 : 620}" font-size="13" fill="#526170">After-workout values are separate; they do not enter the pre-workout average or reference. Missing nights remain gaps.</text>`, '</g>');
  return out;
}

function sleepHistory(nights, { x, left, right, pitch, selected }) {
  const out = ['<g data-section="sleep-history">', '<text x="85" y="656" font-size="19">Sleep stages · same nights</text>'];
  [...stages, unclassified].forEach(([, label, color], index) => {
    const legend = 85 + index * 185;
    out.push(`<rect x="${legend}" y="673" width="14" height="12" fill="${color}"/>`,
      `<text x="${legend + 21}" y="685" font-size="13">${label}</text>`);
  });
  const ph = 150;
  const maximum = Math.max(0, ...nights.map(row => (row.sleep?.sleep_seconds ?? 0) / 3600));
  const high = Math.max(2, Math.ceil(maximum / 2) * 2);
  const y = hours => 710 + ph - hours / high * ph;
  out.push(...grid(0, high, y, left, right), '<text x="40" y="702" font-size="13">hours</text>');
  const barWidth = Math.min(64, pitch * .55);
  nights.forEach((row, index) => {
    const night = row.sleep;
    const duration = night?.sleep_seconds;
    const before = selected(row);
    let label = 'No data';
    if (duration != null) {
      const seconds = night.stages_seconds ?? {};
      const complete = stages.every(([key]) => seconds[key] != null) && Object.values(seconds).reduce((a, b) => a + b, 0) > 0;
      const groups = complete ? stages.map(([key, , color]) => [key, seconds[key], color]) :
        [['unknown', duration, unclassified[2]]];
      let total = 0;
      for (const [key, duration, color] of groups) {
        const hours = duration / 3600;
        total += hours;
        const date = escape(row.wake_date);
        out.push(`<rect data-stage="${key}" data-wake-date="${date}" x="${two(x(index) - barWidth / 2)}" y="${two(y(total))}" width="${two(barWidth)}" height="${two(hours / high * ph)}" fill="${color}" opacity="${row.after ? .5 : 1}"><title>${date}: ${key}, ${duration / 60} min</title></rect>`);
      }
      if (before) out.push(`<rect data-role="selected-sleep" x="${two(x(index) - barWidth / 2)}" y="${two(y(total))}" width="${two(barWidth)}" height="${two(total / high * ph)}" fill="none" stroke="#17212b" stroke-width="2"/>`);
      const minutes = Number(fixed(duration / 60));
      label = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} · ${night.quality_score ?? '—'}`;
    }
    out.push(`<text x="${two(x(index))}" y="884" font-size="14" text-anchor="middle" font-weight="${before ? 'bold' : 'normal'}">${escape(row.wake_date.slice(5))}</text>`,
      `<text x="${two(x(index))}" y="906" font-size="12" text-anchor="middle" fill="#526170">${escape(label)}</text>`);
    if (row.after) {
      const divider = two(left + index * pitch);
      out.push(`<line x1="${divider}" x2="${divider}" y1="705" y2="860" stroke="#a2adb7" stroke-dasharray="4 4"/>`);
    }
  });
  out.push('<text x="622.5" y="932" font-size="14" text-anchor="middle">Wake date · labels: sleep h:mm · quality /100</text>', '</g>');
  return out;
}

export function recoveryCharts(context) {
  const nights = slots(context);
  if (!nights.length) return { lines: [], height: 264 };
  const left = 85, right = 1160, width = right - left, pitch = width / nights.length;
  const position = { left, right, width, pitch, x: index => left + (index + .5) * pitch,
    selected: row => !row.after && row.wake_date === context.before.wake_date };
  return { lines: [...hrvHistory(nights, context, position), ...sleepHistory(nights, position)], height: 900 };
}
