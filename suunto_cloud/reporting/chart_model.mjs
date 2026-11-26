import { activityLabel, footActivity } from '../activities.mjs';
import { gradeSamples } from '../analysis/chart_metrics.mjs';
import { activeSamples, lowerBound, number, seconds, stepLength, sum, timerRanges } from '../analysis/metrics.mjs';
import { fixed } from './format.mjs';

export const WIDTH = 1200, LEFT = 85, RIGHT = 40;
export const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
export const PANEL_HEIGHT = 170, PANEL_SPACING = 280, TICK_SECONDS = 600;

export function workoutTimeLabel(cloud) {
  const start = cloud.start_local;
  const stop = cloud.stop_local;
  const label = start.slice(0, 16).replace('T', ' ');
  if (!stop) return label;
  return label + (stop.slice(0, 10) === start.slice(0, 10)
    ? '–' + stop.slice(11, 16) : ' – ' + stop.slice(0, 16).replace('T', ' '));
}

function segments(points, gap = 2) {
  const groups = [];
  let group;
  for (const point of points) {
    if (!group || point[0] - group.at(-1)[0] > gap) {
      group = [];
      groups.push(group);
    }
    group.push(point);
  }
  return groups;
}

function movingAverage(points, window = 15) {
  return segments(points).flatMap(group => {
    const times = group.map(([time]) => time);
    const sums = [0];
    for (const [, value] of group) sums.push(sums.at(-1) + value);
    return times.map(time => {
      const start = lowerBound(times, time - window / 2);
      const end = lowerBound(times, time + window / 2, true);
      return [time, (sums[end] - sums[start]) / (end - start)];
    });
  });
}

function movingMedian(points, window = 15) {
  return segments(points).flatMap(group => {
    const times = group.map(([time]) => time);
    return times.map(time => {
      const start = lowerBound(times, time - window / 2);
      const end = lowerBound(times, time + window / 2, true);
      const values = group.slice(start, end).map(([, value]) => value).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return [time, values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2];
    });
  });
}

function doubledRange(groups, minimumSpan, nonnegative = false) {
  let low = Infinity;
  let high = -Infinity;
  for (const group of groups) {
    for (const [, value] of group) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  const middle = (low + high) / 2;
  const span = Math.max(high - low, minimumSpan);
  low = nonnegative ? Math.max(0, middle - span) : middle - span;
  return [low, low + 2 * span];
}

function panel(key, title, groups, [lo, hi], color, unit, options = {}) {
  return { key, title, groups, lo, hi, color, unit, inverted: false, style: 'area', rawGroups: null, digits: 0, ...options };
}

export function prepareChart(data, analysis, cloud, hrRange = null, interactive = false) {
  const rows = activeSamples(data, analysis.timer);
  if (!rows.length) return null;
  const intervals = timerRanges(analysis.timer.active_segments);
  const activeTime = time => sum(intervals.map(([start, end]) => Math.max(0, Math.min(time, end) - start)));
  const total = Math.max(1, sum(intervals.map(([start, end]) => end - start)));
  const mapped = (observed, smooth) => {
    const times = observed.map(([time]) => time);
    return intervals.flatMap(([start, end]) => {
      const group = observed.slice(lowerBound(times, start), lowerBound(times, end));
      return (smooth ? smooth(group) : group).map(([time, value]) => [activeTime(time), value]);
    });
  };
  const samples = extract => rows.map(([time, row]) => [time, extract(row)]).filter(([, value]) => number(value));
  const mappedGroups = (rows, smooth) => segments(mapped(rows, smooth));
  const hrObserved = samples(row => row.heart_rate);
  const hr = mapped(hrObserved, movingAverage);
  const altitude = mappedGroups(samples(row => row.altitude), movingAverage);
  const pace = mappedGroups(samples(({ speed }) => number(speed) && speed > 0 ? 1000 / (60 * speed) : null), movingMedian);
  const panels = [];
  if (hr.length) panels.push(panel('heart-rate', 'Heart rate (bpm) · 15 s moving average', [hr],
    hrRange ?? [65, 190], '#b52f3c', 'bpm'));
  if (pace.length) panels.push(panel('pace', 'Pace (min/km) · 15 s moving median', [pace.flat()],
    doubledRange(pace, 0.5, true), '#24679c', 'min/km', { inverted: true }));
  if (altitude.length) panels.push(panel('elevation', 'Elevation (m above sea level) · 15 s moving average', altitude,
    doubledRange(altitude, 1), '#27704d', 'm'));

  function addMetric(key, title, observations, color, unit, minimumSpan, {
    smooth = movingAverage, style = 'area', digits = 0, nonnegative = true,
  } = {}) {
    const groups = mappedGroups(observations, smooth);
    if (!groups.length) return;
    const rawGroups = style === 'scatter' ? mappedGroups(observations) : null;
    const axisGroups = style === 'diverging' ? [...groups, [[0, 0]]] : rawGroups ?? groups;
    panels.push(panel(key, title, groups, doubledRange(axisGroups, minimumSpan, nonnegative), color, unit,
      { style, rawGroups, digits }));
  }

  const field = key => samples(row => number(row[key]) && row[key] >= 0 ? row[key] : null);
  const positive = key => samples(row => number(row[key]) && row[key] > 0 ? row[key] : null);
  const foot = footActivity(cloud, data.sessions?.[0]?.sport);
  const powerTitle = foot === 'running' ? 'Running power' : 'Power';
  const power = field('power');
  addMetric('power', `${powerTitle} (W) · 15 s moving average`, power, '#b47719', 'W', 10);
  const cadenceUnit = foot ? 'steps/min' : 'rpm';
  const cadence = positive('cadence').map(([time, value]) => [time, foot ? value * 2 : value]);
  const scatter = { smooth: movingMedian, style: 'scatter' };
  addMetric('cadence', `Cadence (${cadenceUnit}) · dots + 15 s median trend`, cadence, '#7554a3', cadenceUnit, 5, scatter);
  if (foot) {
    addMetric('ground-contact', 'Ground contact (ms) · dots + 15 s median trend',
      positive('stance_time'), '#98603a', 'ms', 10, scatter);
    addMetric('step-length', 'Estimated step length (m) · dots + 15 s median trend', samples(stepLength),
      '#257c84', 'm', 0.1, { ...scatter, digits: 2 });
  }
  addMetric('speed', 'Speed (km/h) · 15 s moving median', field('speed').map(([time, value]) => [time, value * 3.6]),
    '#24679c', 'km/h', 1, { smooth: movingMedian, digits: 1 });
  addMetric('grade', 'Estimated terrain grade (%) · 50 m window + 15 s mean', gradeSamples(rows, intervals),
    '#27704d', '%', 1, { style: 'diverging', digits: 1, nonnegative: false });
  if (!panels.length) return null;

  const title = ['Workout overview', activityLabel(cloud, data), workoutTimeLabel(cloud)].filter(Boolean).join(' · ');
  const rawLaps = data.laps ?? [];
  const lapTimes = lap => [activeTime(seconds(lap.start_time)), activeTime(seconds(lap.timestamp))];
  const details = analysis.additional_metrics;
  const chart = {
    title, total_seconds: total, panels,
    work_bands: details.slower_next_lap_hr_changes.map(recovery => lapTimes(rawLaps[recovery.work_lap_index - 1])),
    laps: [], distance: [], observed_hr: [], observed_power: [],
  };
  if (interactive) {
    const preferred = new Set(details.preferred_lap_indices);
    const label = details.preferred_lap_kind === 'guided' ? 'Workout step' : 'Lap';
    for (const lap of analysis.laps) {
      if (!preferred.has(lap.index)) continue;
      const [start, end] = lapTimes(rawLaps[lap.index - 1]);
      if (start < end) chart.laps.push({
        label: `${label} ${chart.laps.length + 1}`, start, end,
        distance_m: lap.distance_m, active_seconds: lap.active_seconds,
        avg_hr: lap.avg_hr, max_hr: lap.max_hr, avg_power_w: lap.avg_power_w,
      });
    }
    chart.distance = samples(row => row.distance).map(([time, distance]) => [activeTime(time), distance / 1000]);
    chart.observed_hr = hrObserved.map(([time, value]) => [activeTime(time), value]);
    chart.observed_power = power.map(([time, value]) => [activeTime(time), value]);
  }
  return chart;
}

export function panelY(panel, top, value) {
  return top + (panel.inverted ? value - panel.lo : panel.hi - value) / (panel.hi - panel.lo) * PANEL_HEIGHT;
}

export function panelGeometry(panel, index, headerOffset) {
  const top = 130 + headerOffset + index * PANEL_SPACING;
  return {
    top, baseline: panel.style === 'diverging' ? panelY(panel, top, 0) : top + PANEL_HEIGHT,
    clip_path: `url(#panel-${index})`, area_color: panel.style === 'diverging' ? `url(#grade-${index})` : panel.color,
  };
}

export function interactionPayload(chart, headerOffset) {
  const series = points => points.map(([time, value]) => [Number(fixed(time, 3)), Number(fixed(value, 6))]);
  return {
    title: chart.title, total_seconds: chart.total_seconds, left: LEFT, plot_width: PLOT_WIDTH,
    panel_height: PANEL_HEIGHT, tick_seconds: TICK_SECONDS,
    panels: chart.panels.map((panel, index) => ({
      key: panel.key, label: panel.title.split(' · ')[0], unit: panel.unit, color: panel.color,
      lo: panel.lo, hi: panel.hi, inverted: panel.inverted, digits: panel.digits, style: panel.style,
      ...panelGeometry(panel, index, headerOffset),
      points: series(panel.groups.flat()), group_sizes: panel.groups.map(group => group.length),
      dots: series(panel.rawGroups?.flat() ?? []),
    })),
    laps: chart.laps, work_bands: chart.work_bands, distance: series(chart.distance),
    observed_hr: series(chart.observed_hr), observed_power: series(chart.observed_power),
  };
}
