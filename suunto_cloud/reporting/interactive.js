/* Local-only inspection of existing observations; no interpolated measurements. */
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('chart-data').textContent);
  const svg = document.querySelector('.chart-sheet > svg');
  const timeLabel = document.getElementById('cursor-time');
  const distanceLabel = document.getElementById('cursor-distance');
  const status = document.getElementById('cursor-status');
  const pin = document.getElementById('pin-cursor');
  const clear = document.getElementById('clear-cursor');
  const slider = document.getElementById('cursor-slider');
  const lapPicker = document.getElementById('select-lap');
  const resetZoom = document.getElementById('reset-zoom');
  const rangeStats = document.getElementById('range-stats');
  const ns = 'http://www.w3.org/2000/svg';
  let selected = null;
  let pinned = false;
  let start = 0, end = data.total_seconds;
  let drag = null;
  let suppressClick = false;
  let zoomLayers = [];
  const xAt = time => data.left + (time - start) / (end - start) * data.plot_width;
  const yAt = (panel, value) => {
    const fraction = (value - panel.lo) / (panel.hi - panel.lo);
    return panel.top + (panel.inverted ? fraction : 1 - fraction) * data.panel_height;
  };

  function element(tag, attributes, parent) {
    const node = document.createElementNS(ns, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    parent.appendChild(node);
    return node;
  }

  function bound(points, time, after = false) {
    let lo = 0, hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid][0] < time || (after && points[mid][0] === time)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function nearest(points, time) {
    const lo = bound(points, time);
    let found = points[lo] || null;
    const before = points[lo - 1];
    if (before && (!found || Math.abs(before[0] - time) <= Math.abs(found[0] - time))) found = before;
    return found && Math.abs(found[0] - time) <= 1.001 ? found : null;
  }

  function clock(time) {
    const seconds = Math.round(time);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const tail = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
  }

  function valueLabel(panel, value) {
    if (panel.key === 'pace') {
      return `${clock(value * 60)} /km`;
    }
    const units = { 'heart-rate': 'bpm', elevation: 'm', power: 'W',
      'ground-contact': 'ms', 'step-length': 'm', speed: 'km/h', grade: '%' };
    const unit = panel.key === 'cadence' ? (panel.label.includes('rpm') ? 'rpm' : 'steps/min') : units[panel.key];
    return `${value.toFixed(panel.digits)} ${unit || ''}`.trim();
  }

  const overlay = element('g', { 'data-cursor-overlay': '', visibility: 'hidden', 'aria-hidden': 'true' }, svg);
  const markers = data.panels.map(panel => {
    const group = element('g', { 'data-cursor-panel': panel.key }, overlay);
    const line = element('line', { y1: panel.top, y2: panel.top + data.panel_height,
      stroke: '#17212b', 'stroke-width': 1, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke' }, group);
    const dot = element('circle', { r: 4, fill: panel.color, stroke: 'white', 'stroke-width': 2 }, group);
    element('rect', { x: data.left + data.plot_width - 184, y: panel.top + 7,
      width: 176, height: 27, rx: 5, fill: 'white', 'fill-opacity': .94, stroke: '#dce1e6' }, group);
    const text = element('text', { x: data.left + data.plot_width - 18, y: panel.top + 26,
      'text-anchor': 'end', 'font-family': 'Arial, sans-serif', 'font-size': 16, fill: panel.color }, group);
    return { panel, line, dot, text };
  });
  const selection = element('g', { 'data-selection-overlay': '', visibility: 'hidden', 'aria-hidden': 'true' }, svg);
  const selectionBands = data.panels.map(panel => element('rect', {
    y: panel.top, height: data.panel_height, fill: '#24679c', 'fill-opacity': .22,
  }, selection));
  const plotGroups = data.panels.map(panel => {
    let offset = 0;
    const groups = panel.group_sizes.map(size => {
      const group = panel.points.slice(offset, offset + size);
      offset += size;
      return group;
    });
    return { panel, groups, node: svg.querySelector(`[data-metric="${panel.key}"]`) };
  });

  function show(time) {
    selected = Math.max(start, Math.min(end, time));
    const x = xAt(selected);
    overlay.setAttribute('visibility', 'visible');
    timeLabel.textContent = clock(selected);
    const distance = nearest(data.distance, selected);
    distanceLabel.textContent = distance ? `${distance[1].toFixed(2)} km` : 'No data';
    status.textContent = pinned ? 'Position pinned · scroll to compare panels' : 'Click or tap to pin position';
    pin.disabled = clear.disabled = false;
    pin.setAttribute('aria-pressed', String(pinned));
    pin.textContent = pinned ? 'Release position' : 'Pin position';
    slider.value = selected;
    slider.setAttribute('aria-valuetext', clock(selected));
    for (const { panel, line, dot, text } of markers) {
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      const point = nearest(panel.points, selected);
      text.textContent = point ? valueLabel(panel, point[1]) : 'No data';
      const visible = point && point[0] >= start && point[0] <= end && point[1] >= panel.lo && point[1] <= panel.hi;
      dot.setAttribute('visibility', visible ? 'visible' : 'hidden');
      if (visible) {
        dot.setAttribute('cx', xAt(point[0]));
        dot.setAttribute('cy', yAt(panel, point[1]));
      }
    }
  }

  function reset() {
    selected = null;
    pinned = false;
    overlay.setAttribute('visibility', 'hidden');
    timeLabel.textContent = distanceLabel.textContent = '—';
    status.textContent = 'Move across a workout panel';
    pin.disabled = clear.disabled = true;
    pin.setAttribute('aria-pressed', 'false');
    pin.textContent = 'Pin position';
    slider.value = start;
    slider.setAttribute('aria-valuetext', 'No position selected');
  }

  function eventTime(event, clamp = false) {
    const transform = svg.getScreenCTM();
    if (!transform) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(transform.inverse());
    const fraction = (local.x - data.left) / data.plot_width;
    if (!clamp && (fraction < 0 || fraction > 1 ||
        !data.panels.some(panel => local.y >= panel.top && local.y <= panel.top + data.panel_height))) return null;
    return start + Math.max(0, Math.min(1, fraction)) * (end - start);
  }

  function redraw() {
    for (const layer of zoomLayers) layer.remove();
    zoomLayers = [];
    if (start === 0 && end === data.total_seconds) {
      svg.removeAttribute('data-zoomed');
      return;
    }
    svg.setAttribute('data-zoomed', '');
    for (const { panel, groups, node } of plotGroups) {
      const layer = element('g', { 'data-zoom-layer': '', 'aria-hidden': 'true' }, node);
      zoomLayers.push(layer);
      const bottom = panel.top + data.panel_height;
      for (const [from, to] of data.work_bands) {
        const a = Math.max(start, from), b = Math.min(end, to);
        if (a < b) element('rect', { x: xAt(a), y: panel.top, width: xAt(b) - xAt(a),
          height: data.panel_height, fill: '#e8f0f8', 'fill-opacity': .65 }, layer);
      }
      for (let tick = Math.ceil(start / 600) * 600; tick <= end; tick += 600) {
        const x = xAt(tick);
        element('line', { x1: x, x2: x, y1: panel.top, y2: bottom, stroke: '#dce1e6' }, layer);
        const label = element('text', { x, y: bottom + 25, 'font-size': 16, 'text-anchor': 'middle' }, layer);
        label.textContent = tick / 60;
      }
      const plot = element('g', { 'clip-path': panel.clip_path }, layer);
      for (const [time, value] of panel.dots.slice(bound(panel.dots, start), bound(panel.dots, end, true))) {
        element('circle', { cx: xAt(time), cy: yAt(panel, value), r: 1.8,
          fill: panel.color, 'fill-opacity': .35 }, plot);
      }
      for (const group of groups) {
        if (group.length < 2 || group[0][0] > end || group[group.length - 1][0] < start) continue;
        // Include adjacent points only for visual continuity at the clipped edges.
        const visible = group.slice(Math.max(0, bound(group, start) - 1), bound(group, end, true) + 1);
        const coords = visible.map(([time, value]) => `${xAt(time).toFixed(2)},${yAt(panel, value).toFixed(2)}`).join(' ');
        if (panel.style !== 'scatter') {
          const first = xAt(visible[0][0]), last = xAt(visible[visible.length - 1][0]);
          element('polygon', { points: `${first},${panel.baseline} ${coords} ${last},${panel.baseline}`,
            fill: panel.area_color, 'fill-opacity': .25 }, plot);
        }
        element('polyline', { points: coords, fill: 'none', stroke: panel.color, 'stroke-width': 1.8,
          'stroke-linejoin': 'round' }, plot);
      }
    }
  }

  function observedStats(points) {
    const samples = points.slice(bound(points, start), bound(points, end));
    if (!samples.length) return [null, null];
    let sum = 0, max = -Infinity;
    for (const [, value] of samples) {
      sum += value;
      max = Math.max(max, value);
    }
    return [sum / samples.length, max];
  }

  function statsForRange() {
    const distance = data.distance.slice(bound(data.distance, start), bound(data.distance, end, true));
    const first = distance[0], last = distance[distance.length - 1];
    const valid = distance.length > 1 && last[0] > first[0] &&
      distance.every((point, i) => i === 0 || point[1] >= distance[i - 1][1]);
    const [avgHR, maxHR] = observedStats(data.observed_hr);
    const [avgPower] = observedStats(data.observed_power);
    const km = valid ? last[1] - first[1] : null;
    return { active_seconds: end - start, distance_m: km === null ? null : km * 1000,
      pace: km > 0 ? (last[0] - first[0]) / km : null, avg_hr: avgHR, max_hr: maxHR, avg_power_w: avgPower };
  }

  function zoom(from, to, lap = null) {
    start = from;
    end = to;
    slider.min = start;
    slider.max = end;
    resetZoom.disabled = start === 0 && end === data.total_seconds && !lap;
    if (resetZoom.disabled) {
      rangeStats.textContent = '';
    } else {
      const stats = lap || statsForRange();
      const format = (value, suffix) => Number.isFinite(value) ? `${Math.round(value)}${suffix}` : '—';
      const distance = Number.isFinite(stats.distance_m) ? `${(stats.distance_m / 1000).toFixed(3)} km` : '—';
      const pace = lap && stats.distance_m > 0 && Number.isFinite(stats.active_seconds) ?
        stats.active_seconds / (stats.distance_m / 1000) : stats.pace;
      const range = `${clock(start)}–${clock(end)}`;
      const kind = lap ? `${lap.label} (FIT) · ${range}` : `${range} (samples)`;
      const hr = `${format(stats.avg_hr, '')}/${format(stats.max_hr, '')}`;
      rangeStats.textContent = `${kind} · Active ${Number.isFinite(stats.active_seconds) ? clock(stats.active_seconds) : '—'} · ` +
        `${distance} · Pace ${Number.isFinite(pace) ? clock(pace) + ' /km' : '—'} · HR avg/max ${hr} bpm · ` +
        `Power avg ${format(stats.avg_power_w, ' W')}`;
    }
    redraw();
    reset();
  }

  svg.addEventListener('pointerdown', event => {
    suppressClick = false;
    if (event.button !== 0 || event.pointerType === 'touch' || drag) return;
    const time = eventTime(event);
    if (time === null) return;
    drag = { id: event.pointerId, time, clientX: event.clientX, moved: false };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    if (drag && drag.id === event.pointerId) {
      if (Math.abs(event.clientX - drag.clientX) >= 5) drag.moved = true;
      if (drag.moved) {
        const time = eventTime(event, true);
        if (time === null) return;
        const first = xAt(Math.min(drag.time, time)), last = xAt(Math.max(drag.time, time));
        selection.setAttribute('visibility', 'visible');
        for (const band of selectionBands) {
          band.setAttribute('x', first);
          band.setAttribute('width', last - first);
        }
      }
      return;
    }
    if (pinned || event.pointerType === 'touch') return;
    const time = eventTime(event);
    if (time !== null) show(time);
  });
  svg.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const gesture = drag;
    drag = null;
    selection.setAttribute('visibility', 'hidden');
    if (!gesture.moved) return;
    suppressClick = true;
    const time = eventTime(event, true);
    if (time === null || Math.abs(time - gesture.time) < 1) return;
    lapPicker.value = '';
    zoom(Math.min(time, gesture.time), Math.max(time, gesture.time));
  });
  svg.addEventListener('lostpointercapture', () => {
    drag = null;
    selection.setAttribute('visibility', 'hidden');
  });
  svg.addEventListener('click', event => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const time = eventTime(event);
    if (time === null) return;
    if (pinned) { pinned = false; show(time); }
    else { pinned = true; show(time); }
  });
  pin.addEventListener('click', () => { if (selected !== null) { pinned = !pinned; show(selected); } });
  clear.addEventListener('click', reset);
  slider.addEventListener('input', () => { pinned = true; show(Number(slider.value)); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') reset(); });
  resetZoom.addEventListener('click', () => {
    lapPicker.value = '';
    zoom(0, data.total_seconds);
  });
  lapPicker.addEventListener('change', () => {
    const lap = data.laps[lapPicker.value];
    if (lap) zoom(lap.start, lap.end, lap);
    else zoom(0, data.total_seconds);
  });

  document.getElementById('download-svg').addEventListener('click', event => {
    const copy = svg.cloneNode(true);
    copy.removeAttribute('data-zoomed');
    copy.querySelectorAll('[data-cursor-overlay], [data-selection-overlay], [data-zoom-layer]')
      .forEach(layer => layer.remove());
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = event.currentTarget.dataset.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
