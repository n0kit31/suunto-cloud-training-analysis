/* Exercise the shipped script's events in a small DOM, including scaled SVG coordinates. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div', attributes = {}) {
    this.tag = tag; this.attributes = attributes; this.children = [];
    this.listeners = {}; this.textContent = ''; this.value = ''; this.disabled = false;
    this.dataset = {};
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  dispatch(type, values = {}) { this.listeners[type]?.({ currentTarget: this, ...values }); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelector(selector) {
    const [attribute, value] = selector.slice(1, -1).split('=');
    for (const child of this.children) {
      if (attribute in child.attributes && (value === undefined || child.attributes[attribute] === JSON.parse(value))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const generated = process.argv[2] === '--generated' ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
const fixturePanels = [
  { key: 'heart-rate', unit: 'bpm', color: 'red', lo: 65, hi: 190, digits: 0, top: 130,
    points: [[0, 120], [10, 150], [20, 160]] },
  { key: 'pace', unit: 'min/km', color: 'blue', lo: 3, hi: 8, digits: 0, inverted: true, top: 410,
    points: [[0, 5], [10, 4.5], [20, 6]] },
  { key: 'elevation', unit: 'm', color: 'green', lo: 0, hi: 100, digits: 0, top: 690,
    points: [[0, 50], [20, 60]] },
];
const data = generated?.data ?? { panels: fixturePanels, total_seconds: 20,
  left: 85, plot_width: 1075, panel_height: 170, tick_seconds: 600,
  distance: [[0, 0], [10, 0.04], [20, 0.08]],
  observed_hr: [[0, 130], [10, 170], [20, 180]], observed_power: [[0, 200], [10, 300]],
  work_bands: [[0, 10]],
  laps: [{ label: 'Workout step 1', start: 0, end: 10, distance_m: 50,
    active_seconds: 10, avg_hr: 140, max_hr: 160, avg_power_w: 230 }] };
const panels = data.panels;
const ids = Object.fromEntries(['chart-data', 'cursor-time', 'cursor-distance', 'cursor-status',
  'pin-cursor', 'clear-cursor', 'cursor-slider', 'download-svg', 'reset-zoom', 'select-lap',
  'range-stats'].map(id => [id, new Element()]));
const svg = new Element('svg');
for (const panel of fixturePanels) {
  panel.group_sizes = panel.key === 'elevation' ? [1, 1] : [panel.points.length];
  panel.dots = [];
  panel.clip_path = 'url(#panel)';
  panel.baseline = panel.top + 170;
}
for (const attributes of generated?.panels ?? panels.map(panel => ({ 'data-metric': panel.key }))) {
  svg.appendChild(new Element('g', attributes));
}
ids['chart-data'].textContent = JSON.stringify(data);
svg.setPointerCapture = () => {};
// Simulate 50% scaling and a scrolled viewport. Screen CTM conversion must undo both.
svg.getScreenCTM = () => ({ inverse: () => ({}) });
svg.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: (this.x - 20) * 2, y: (this.y + 200) * 2 }; } });
const document = new Element('document');
document.getElementById = id => ids[id];
document.querySelector = () => svg;
document.createElementNS = (_ns, tag) => new Element(tag);
const script = generated?.script ?? fs.readFileSync(path.join(__dirname, '../../suunto_cloud/reporting/interactive.js'), 'utf8');
vm.runInNewContext(script, { document, setTimeout });
const event = (time, panel = 0) => ({ clientX: 20 + (data.left + time / data.total_seconds * data.plot_width) / 2,
  clientY: (panels[panel].top + 70) / 2 - 200, pointerType: 'mouse', pointerId: 1, button: 0 });
const overlay = svg.querySelector('[data-cursor-overlay]');

if (generated) {
  assert.equal(data.total_seconds, 120);
  svg.dispatch('pointermove', event(22));
  assert.equal(overlay.children[0].children[3].textContent, 'No data');
  svg.dispatch('pointermove', event(10));
  const cadence = svg.querySelector('[data-cursor-panel="cadence"]');
  assert.match(cadence.children[3].textContent, / rpm$/);
  ids['select-lap'].value = '0';
  ids['select-lap'].dispatch('change');
  assert.match(ids['range-stats'].textContent, /\(FIT\)/);
  assert.ok(svg.querySelector('[data-zoom-layer]'));
  ids['reset-zoom'].dispatch('click');
  assert.equal(svg.querySelector('[data-zoom-layer]'), null);
  process.exit(0);
}

svg.dispatch('pointermove', event(10));
assert.equal(ids['cursor-time'].textContent, '0:10');
assert.equal(ids['cursor-distance'].textContent, '0.04 km');
assert.equal(overlay.attributes.visibility, 'visible');
assert.equal(new Set(overlay.children.map(group => group.children[0].attributes.x1)).size, 1);
assert.equal(overlay.children[0].children[3].textContent, '150 bpm');
assert.equal(overlay.children[1].children[3].textContent, '4:30 /km');
assert.equal(overlay.children[2].children[3].textContent, 'No data');
assert.equal(overlay.children[2].children[1].attributes.visibility, 'hidden');

svg.dispatch('click', event(10));
assert.equal(ids['pin-cursor'].attributes['aria-pressed'], 'true');
svg.dispatch('pointermove', event(20, 2));
assert.equal(ids['cursor-time'].textContent, '0:10');
ids['pin-cursor'].dispatch('click');
svg.dispatch('pointermove', event(20, 2));
assert.equal(ids['cursor-time'].textContent, '0:20');
assert.equal(overlay.children[2].children[3].textContent, '60 m');

ids['cursor-slider'].value = '0';
ids['cursor-slider'].dispatch('input');
assert.equal(ids['cursor-distance'].textContent, '0.00 km');
assert.equal(ids['pin-cursor'].attributes['aria-pressed'], 'true');
document.dispatch('keydown', { key: 'Escape' });
assert.equal(overlay.attributes.visibility, 'hidden');
assert.equal(ids['pin-cursor'].disabled, true);
assert.equal(ids['cursor-slider'].attributes['aria-valuetext'], 'No position selected');

// A calendar/recovery panel must not select an unrelated workout position.
svg.dispatch('pointermove', { clientX: 300, clientY: -190, pointerType: 'mouse' });
assert.equal(overlay.attributes.visibility, 'hidden');
svg.dispatch('pointermove', { ...event(10), pointerType: 'touch' });
assert.equal(overlay.attributes.visibility, 'hidden');
svg.dispatch('click', event(10));
assert.equal(ids['pin-cursor'].attributes['aria-pressed'], 'true');
ids['clear-cursor'].dispatch('click');
assert.equal(overlay.attributes.visibility, 'hidden');

svg.dispatch('pointerdown', event(20));
svg.dispatch('pointermove', event(0));
svg.dispatch('pointermove', event(10));
svg.dispatch('pointerup', event(10));
svg.dispatch('click', event(10));
assert.equal(overlay.attributes.visibility, 'hidden'); // Drag must not pin the cursor.
assert.equal(ids['cursor-slider'].min, 10);
assert.match(ids['range-stats'].textContent, /HR avg\/max 170\/170 bpm/);
svg.dispatch('pointermove', event(0));
assert.equal(ids['cursor-time'].textContent, '0:10');
assert.equal(overlay.children[0].children[0].attributes.x1, '85');
assert.ok(svg.querySelector('[data-zoom-layer]'));
assert.equal(svg.children[2].querySelector('[data-zoom-layer]').children.at(-1).children.length, 0);

ids['select-lap'].value = '0';
ids['select-lap'].dispatch('change');
assert.match(ids['range-stats'].textContent, /Workout step 1 \(FIT\).*0\.050 km.*HR avg\/max 140\/160 bpm/);
assert.equal(ids['cursor-slider'].max, 10);
ids['reset-zoom'].dispatch('click');
assert.equal(ids['cursor-slider'].max, 20);
assert.equal(svg.querySelector('[data-zoom-layer]'), null);
console.log('Cursor and zoom checks passed.');
