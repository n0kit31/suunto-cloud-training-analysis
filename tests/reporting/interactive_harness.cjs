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
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  dispatch(type, values = {}) { this.listeners[type]?.({ currentTarget: this, ...values }); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelector(selector) {
    const attribute = selector.slice(1, -1);
    for (const child of this.children) {
      if (attribute in child.attributes) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const panels = [
  { key: 'heart-rate', color: 'red', lo: 65, hi: 190, digits: 0, top: 130,
    points: [[0, 120], [10, 150], [20, 160]] },
  { key: 'pace', color: 'blue', lo: 3, hi: 8, digits: 0, inverted: true, top: 410,
    points: [[0, 5], [10, 4.5], [20, 6]] },
  { key: 'elevation', color: 'green', lo: 0, hi: 100, digits: 0, top: 690,
    points: [[0, 50], [20, 60]] },
];
const data = { panels, total_seconds: 20, left: 85, plot_width: 1075, panel_height: 170,
  distance: [[0, 0], [10, 0.04], [20, 0.08]] };
const ids = Object.fromEntries(['chart-data', 'cursor-time', 'cursor-distance', 'cursor-status',
  'pin-cursor', 'clear-cursor', 'cursor-slider', 'download-svg'].map(id => [id, new Element()]));
ids['chart-data'].textContent = JSON.stringify(data);
const svg = new Element('svg');
// Simulate 50% scaling and a scrolled viewport. Screen CTM conversion must undo both.
svg.getScreenCTM = () => ({ inverse: () => ({}) });
svg.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: (this.x - 20) * 2, y: (this.y + 200) * 2 }; } });
const document = new Element('document');
document.getElementById = id => ids[id];
document.querySelector = () => svg;
document.createElementNS = (_ns, tag) => new Element(tag);
const script = fs.readFileSync(path.join(__dirname, '../../suunto_cloud/reporting/interactive.js'), 'utf8');
vm.runInNewContext(script, { document, setTimeout });
const event = (time, panel = 0) => ({ clientX: 20 + (85 + time / 20 * 1075) / 2,
  clientY: (panels[panel].top + 70) / 2 - 200, pointerType: 'mouse' });
const overlay = svg.children[0];

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
console.log('Cursor checks passed: alignment, scaling, gaps, pin, clear, keyboard and touch selection.');
