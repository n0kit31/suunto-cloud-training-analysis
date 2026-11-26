import {
  LEFT, PANEL_HEIGHT, PANEL_SPACING, PLOT_WIDTH, RIGHT, TICK_SECONDS, WIDTH,
  interactionPayload, panelGeometry, panelY, prepareChart,
} from './chart_model.mjs';
import { duration, escape, fixed } from './format.mjs';
import { workoutHighlights } from '../analysis/workout_highlights.mjs';
import { workoutTiles } from './workout_tiles.mjs';
import { recoveryHeader } from './recovery.mjs';

export function thin(points, limit) {
  if (points.length <= limit) return points;
  const width = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(limit / 4))));
  const result = [];
  for (let start = 0; start < points.length; start += width) {
    const end = Math.min(start + width, points.length);
    let lowest = start;
    let highest = start;
    for (let index = start + 1; index < end; index++) {
      if (points[index][1] < points[lowest][1]) lowest = index;
      if (points[index][1] > points[highest][1]) highest = index;
    }
    const indices = [...new Set([start, lowest, highest, end - 1])].sort((a, b) => a - b);
    result.push(...indices.map(index => points[index]));
  }
  return result;
}

function renderPanel(panel, index, chart, headerOffset, x) {
  const ph = PANEL_HEIGHT;
  const rightEdge = WIDTH - RIGHT;
  const { groups, lo, hi, color, style, rawGroups } = panel;
  const { top, baseline, clip_path: clip, area_color: areaColor } = panelGeometry(panel, index, headerOffset);
  const y = value => panelY(panel, top, value);
  const two = value => fixed(value, 2);
  const lines = [
    `<g data-metric="${panel.key}" data-style="${style}">`,
    `<defs><clipPath id="panel-${index}"><rect x="${LEFT}" y="${top}" width="${PLOT_WIDTH}" height="${ph}"/></clipPath></defs>`,
    `<text x="${LEFT}" y="${top - 25}" font-size="19">${escape(panel.title)}</text>`,
  ];
  for (const [start, end] of chart.work_bands) {
    lines.push(`<rect data-full-plot="" x="${two(x(start))}" y="${top}" width="${two(x(end) - x(start))}" height="${ph}" fill="#e8f0f8"/>`);
  }
  for (let tick = 0; tick < 6; tick++) {
    const value = lo + tick * (hi - lo) / 5;
    const label = panel.inverted ? duration(Number(fixed(value * 60))).replace(/\.0$/, '') : fixed(value, panel.digits);
    lines.push(
      `<line x1="${LEFT}" y1="${two(y(value))}" x2="${rightEdge}" y2="${two(y(value))}" stroke="#dce1e6"/>`,
      `<text x="${LEFT - 12}" y="${two(y(value) + 5)}" font-size="16" text-anchor="end">${label}</text>`,
    );
  }
  for (let time = 0; time <= Math.floor(chart.total_seconds); time += TICK_SECONDS) {
    lines.push(
      `<line data-full-plot="" data-active-tick="${time}" x1="${two(x(time))}" x2="${two(x(time))}" y1="${top}" y2="${top + ph}" stroke="#dce1e6"/>`,
      `<text data-full-plot="" x="${two(x(time))}" y="${top + ph + 25}" font-size="16" text-anchor="middle">${time / 60}</text>`,
    );
  }
  if (rawGroups) {
    const count = rawGroups.reduce((total, group) => total + group.length, 0);
    for (const group of rawGroups) {
      for (const [time, value] of thin(group, Math.max(4, Math.floor(600 * group.length / Math.max(1, count))))) {
        lines.push(`<circle data-full-plot="" cx="${two(x(time))}" cy="${two(y(value))}" r="1.8" fill="${color}" fill-opacity="0.35" clip-path="${clip}"/>`);
      }
    }
  }
  if (style === 'diverging') {
    const offset = fixed(100 - 100 * (0 - lo) / (hi - lo), 4);
    lines.push(
      `<defs><linearGradient id="grade-${index}" x1="0" y1="${top}" x2="0" y2="${top + ph}" gradientUnits="userSpaceOnUse">`,
      `<stop offset="${offset}%" stop-color="#27704d"/>`,
      `<stop offset="${offset}%" stop-color="#24679c"/></linearGradient></defs>`,
      `<line x1="${LEFT}" x2="${rightEdge}" y1="${two(baseline)}" y2="${two(baseline)}" stroke="#788795" stroke-dasharray="4 3"/>`,
    );
  }
  const count = groups.reduce((total, group) => total + group.length, 0);
  for (const group of groups) {
    const points = thin(group, Math.max(4, Math.floor(1600 * group.length / Math.max(1, count))));
    if (points.length < 2) continue;
    const coords = points.map(([time, value]) => `${two(x(time))},${two(y(value))}`).join(' ');
    if (style !== 'scatter') {
      const area = `${two(x(points[0][0]))},${two(baseline)} ${coords} ${two(x(points.at(-1)[0]))},${two(baseline)}`;
      lines.push(`<polygon data-full-plot="" points="${area}" fill="${areaColor}" fill-opacity="0.25" clip-path="${clip}"/>`);
    }
    lines.push(`<polyline data-full-plot="" points="${coords}" fill="none" stroke="${color}" stroke-width="1.8" clip-path="${clip}" stroke-linejoin="round"/>`);
  }
  lines.push(`<text x="${LEFT + PLOT_WIDTH / 2}" y="${top + ph + 49}" font-size="16" text-anchor="middle">Active workout time (min)</text>`, '</g>');
  return lines;
}

export function renderChart(chart, header, headerOffset, recovery = null) {
  const height = 140 + chart.panels.length * PANEL_SPACING + headerOffset;
  const x = time => LEFT + time / chart.total_seconds * PLOT_WIDTH;
  const heading = escape(chart.title);
  const headingSize = [...chart.title].length <= 85 ? 25 : 20;
  let subtitle = 'Time axis: active workout time';
  if (recovery?.nights_7d?.length && recovery.before) subtitle = 'Workout panels: active time · Recovery panels: local wake date';
  if (chart.work_bands.length) subtitle += ' · blue bands: interval before a slower workout step';
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title desc">`,
    '<!-- generated: suunto-analysis -->',
    `<title id="title">${heading}</title>`,
    '<desc id="desc">Workout panels use active workout time; recovery panels use local wake dates. ' +
      'Heart rate: centered 15 s moving average, with gaps connected linearly on the chart. ' +
      'Pace: centered 15 s moving median. Elevation: centered 15 s moving average. ' +
      'Smoothing resets at pauses and gaps over 2 s. Pace gaps are connected linearly on the chart only; ' +
      'elevation retains measurement gaps. ' +
      'Pace and elevation axes double the smoothed min-max span around its midpoint; ' +
      'pace is bounded below by zero. Minimum data spans: 0.5 min/km and 1 m. ' +
      'Power: 15 s mean. Speed: 15 s median. Cadence, contact and estimated step length: ' +
      'observed dots with a 15 s median trend, without area fill. Dots are reduced preserving extrema. ' +
      'Cadence uses steps/min for running/walking and rpm otherwise. Step length = 30 * speed / cadence. ' +
      'Grade: local rise/run over up to ±25 m, minimum 20 m and three observations, then 15 s mean. ' +
      'No grade is estimated across missing inputs, pauses, distance resets or stationary samples. ' +
      'New axes double the displayed min-max span, including raw dots and zero for grade. ' +
      'All source data remain unchanged. Areas fill to the panel bottom except signed grade, ' +
      'which fills toward zero (green uphill, blue downhill). Missing metrics are omitted.</desc>',
    `<rect width="${WIDTH}" height="${height}" fill="#ffffff"/>`,
    '<g font-family="Arial, sans-serif" fill="#17212b">',
    `<text x="85" y="35" font-size="${headingSize}">${heading}</text>`,
    `<text x="85" y="65" font-size="17">${subtitle}</text>`,
    ...header,
  ];
  chart.panels.forEach((panel, index) => lines.push(...renderPanel(panel, index, chart, headerOffset, x)));
  lines.push(
    `<text x="85" y="${height - 35}" font-size="14">15 s smoothing; HR/pace gaps connected only on chart. Other gaps retained. Non-HR axes: doubled min-max span.</text>`,
    `<text x="85" y="${height - 15}" font-size="14">Dots: observed samples + median trend. Grade: 50 m rise/run; green uphill, blue downhill. Missing metrics omitted.</text>`,
    '</g></svg>',
  );
  return lines.join('\n') + '\n';
}

export function workoutChart(data, analysis, cloud, hrRange = null, interactive = true, recovery = null) {
  const chart = prepareChart(data, analysis, cloud, hrRange, interactive);
  if (!chart) return { svg: null, interaction: null };
  const tiles = workoutTiles(cloud, workoutHighlights(cloud, analysis));
  const restored = recoveryHeader(recovery, cloud.summary?.feeling, tiles.height);
  const header = [...tiles.lines, ...(restored?.lines ?? [])];
  const offset = tiles.height + (restored?.height ?? 0);
  return {
    svg: renderChart(chart, header, offset, recovery),
    interaction: interactive ? interactionPayload(chart, offset) : null,
  };
}
