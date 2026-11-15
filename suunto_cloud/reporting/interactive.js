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
  const ns = 'http://www.w3.org/2000/svg';
  let selected = null;
  let pinned = false;

  function element(tag, attributes, parent) {
    const node = document.createElementNS(ns, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    parent.appendChild(node);
    return node;
  }

  function nearest(points, time) {
    let lo = 0, hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid][0] < time) lo = mid + 1;
      else hi = mid;
    }
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
      const seconds = Math.round(value * 60);
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} /km`;
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

  function show(time) {
    selected = Math.max(0, Math.min(data.total_seconds, time));
    const x = data.left + selected / data.total_seconds * data.plot_width;
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
      const visible = point && point[1] >= panel.lo && point[1] <= panel.hi;
      dot.setAttribute('visibility', visible ? 'visible' : 'hidden');
      if (visible) {
        dot.setAttribute('cx', data.left + point[0] / data.total_seconds * data.plot_width);
        const fraction = (point[1] - panel.lo) / (panel.hi - panel.lo);
        dot.setAttribute('cy', panel.top + (panel.inverted ? fraction : 1 - fraction) * data.panel_height);
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
    slider.value = 0;
    slider.setAttribute('aria-valuetext', 'No position selected');
  }

  function eventTime(event) {
    const transform = svg.getScreenCTM();
    if (!transform) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(transform.inverse());
    if (local.x < data.left || local.x > data.left + data.plot_width ||
        !data.panels.some(panel => local.y >= panel.top && local.y <= panel.top + data.panel_height)) return null;
    return (local.x - data.left) / data.plot_width * data.total_seconds;
  }

  svg.addEventListener('pointermove', event => {
    if (pinned || event.pointerType === 'touch') return;
    const time = eventTime(event);
    if (time !== null) show(time);
  });
  svg.addEventListener('click', event => {
    const time = eventTime(event);
    if (time === null) return;
    if (pinned) { pinned = false; show(time); }
    else { pinned = true; show(time); }
  });
  pin.addEventListener('click', () => { if (selected !== null) { pinned = !pinned; show(selected); } });
  clear.addEventListener('click', reset);
  slider.addEventListener('input', () => { pinned = true; show(Number(slider.value)); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') reset(); });

  document.getElementById('download-svg').addEventListener('click', event => {
    const copy = svg.cloneNode(true);
    copy.querySelector('[data-cursor-overlay]').remove();
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
