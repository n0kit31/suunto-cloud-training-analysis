import { readFileSync } from 'node:fs';
import { escape } from './format.mjs';

const css = readFileSync(new URL('./interactive.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('./interactive.js', import.meta.url), 'utf8');

export function chartHtml(svg, interaction, filename, summary = '') {
  const payload = JSON.stringify(interaction).replace(/[&<>\u2028\u2029]/g, char =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  const options = interaction.laps.map((lap, index) => `<option value="${index}">${escape(lap.label)}</option>`).join('');
  return `<!doctype html>
<!-- generated: suunto-analysis -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(interaction.title)}</title>
<style>${css}</style>
</head>
<body>
<header class="inspector" aria-label="Workout chart inspector">
  <div class="readout"><span>Active time</span><strong id="cursor-time">—</strong></div>
  <div class="readout"><span>Distance</span><strong id="cursor-distance">—</strong></div>
  <span id="cursor-status" role="status">Move across a workout panel</span>
  <div class="actions">
    <button id="pin-cursor" type="button" aria-pressed="false" disabled>Pin position</button>
    <button id="clear-cursor" type="button" disabled>Clear</button>
    <button id="download-svg" type="button" data-filename="${escape(filename)}">Download SVG</button>
  </div>
  <div class="zoom-controls">
    <label>Select a lap
      <select id="select-lap"${options ? '' : ' disabled'}>
        <option value="">Choose a lap</option>${options}
      </select>
    </label>
    <button id="reset-zoom" type="button" disabled>Full workout</button>
    <output id="range-stats" aria-live="polite"></output>
  </div>
  <label class="timeline">Select active time
    <input id="cursor-slider" type="range" min="0" max="${interaction.total_seconds}" step="1" value="0"
           aria-label="Selected active workout time" aria-valuetext="No position selected">
  </label>
</header>
<main>
  ${summary}
  <p class="help">Move to inspect all workout panels. Click or tap to pin; click again or press Escape to release.
  Drag across a panel to zoom or select a lap above.
  Lap statistics use FIT lap summaries. Drag selections use recorded samples, with distance and pace measured between the first and last distance samples in the range.
  Readouts follow the smoothed lines at nearby recorded times (within 1 second); gaps show “No data”.
  Sleep and HRV use their own calendar axis.</p>
  <noscript><p>The charts are visible below. Enable JavaScript for synchronized readouts.</p></noscript>
  <div class="chart-sheet">${svg}</div>
</main>
<script id="chart-data" type="application/json">${payload}</script>
<script>${script}</script>
</body>
</html>
`;
}
