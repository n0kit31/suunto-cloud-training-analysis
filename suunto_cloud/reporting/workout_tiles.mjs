import { number } from '../analysis/metrics.mjs';
import { celsiusFromKelvin } from '../analysis/workout_highlights.mjs';
import { LEFT, PLOT_WIDTH } from './chart_model.mjs';
import { fixed, escape } from './format.mjs';

const palettes = {
  cold: ['#e8f3ff', '#225c91', '#bcd9f5'], mild: ['#e9f7f3', '#206a5d', '#bcded5'],
  weather: ['#f0f6fb', '#345875', '#d6e4ef'], recovery: ['#f2effb', '#544383', '#ded5f1'],
  green: ['#e8f5eb', '#226b3c', '#c5e2cd'], yellow: ['#fff4d2', '#886000', '#edd489'],
  red: ['#fde8e8', '#a22e36', '#efbec2'], unknown: ['#f3f6f8', '#526170', '#dce2e7'],
};
const ratings = { Excellent: 'green', Normal: 'yellow', Slow: 'red' };
const conditions = {
  '01': 'Clear sky', '02': 'Partly cloudy', '03': 'Scattered clouds',
  '04': 'Broken clouds', '09': 'Showers', '10': 'Rain', '11': 'Thunderstorm',
  '13': 'Snow', '50': 'Mist',
};
const sun = '<circle cx="22" cy="23" r="10" fill="#f7bb4c"/>' +
  '<path d="M22 5v5m0 26v5M4 23h5m26 0h5M9 10l4 4m18 18 4 4M9 36l4-4m18-18 4-4" fill="none" stroke="#cc801b" stroke-width="2" stroke-linecap="round"/>';
const moon = '<path d="M26 7a15 15 0 1 0 12 20A14 14 0 0 1 26 7Z" fill="#7778bf"/>';
const cloudIcon = '<path d="M16 38a9 9 0 0 1 1-18 13 13 0 0 1 25 1 8.5 8.5 0 0 1 2 17Z" fill="#d0dfef" stroke="#7292ac" stroke-width="1.7"/>';
const precipitation = {
  '09': '<path d="m21 43-3 6m13-6-3 6m13-6-3 6" stroke="#4389c2" stroke-width="2.5" stroke-linecap="round"/>',
  '11': '<path d="m31 36-7 10h6l-2 8 11-12h-7l3-6Z" fill="#e6ac31"/>',
  '13': '<g fill="#639bc4"><circle cx="21" cy="46" r="2"/><circle cx="31" cy="49" r="2"/><circle cx="41" cy="46" r="2"/></g>',
  '50': '<path d="M15 44h31m-25 5h20" stroke="#7292ac" stroke-width="2" stroke-linecap="round"/>',
};

export function recoveryLabels(highlights) {
  const minutes = Number(fixed(highlights.recovery_seconds / 60));
  const duration = `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
  const kind = highlights.recovery_kind === 'cumulative' ? 'Accumulated estimate' : 'Workout estimate';
  const until = highlights.recovery_until ? 'Until ' + highlights.recovery_until.slice(0, 16).replace('T', ' ') : '';
  return [duration, kind, until];
}

function weatherIcon(code) {
  const condition = code.slice(0, 2);
  if (!Object.hasOwn(conditions, condition)) {
    return '<path d="M8 18h30q8 0 8-6t-6-6m-32 22h40q8 0 8 7t-7 7M8 38h23" fill="none" stroke="#7292ac" stroke-width="2.5" stroke-linecap="round"/>';
  }
  const light = code.endsWith('n') ? moon : sun;
  if (condition === '01') return `<g transform="translate(9 4)">${light}</g>`;
  const behind = ['02', '10'].includes(condition) ? `<g transform="translate(2 0) scale(.76)">${light}</g>` : '';
  return behind + cloudIcon + (precipitation[condition === '10' ? '09' : condition] ?? '');
}

function weatherCard(weather) {
  const code = typeof weather.weatherIcon === 'string' && /^..[dn]$/.test(weather.weatherIcon) ? weather.weatherIcon : '';
  const temperature = celsiusFromKelvin(weather.temperature);
  const { humidity, windSpeed: wind, windDirection: direction } = weather;
  const details = [];
  if (number(wind) && wind >= 0) {
    const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const suffix = wind > 0 && number(direction) && direction >= 0 && direction <= 360
      ? ' ' + compass[Math.floor((direction + 22.5) / 45) % 8] : '';
    details.push(`Wind ${fixed(wind * 3.6, 1)} km/h${suffix}`);
  }
  if (number(humidity) && humidity >= 0 && humidity <= 100) details.push(`Humidity ${fixed(humidity)}%`);
  const condition = conditions[code.slice(0, 2)] ?? '';
  if (temperature === null && !condition && !details.length) return null;
  return ['Weather', temperature === null ? condition || 'Conditions' : fixed(temperature, 1) + ' °C',
    temperature === null ? '' : condition, details.join(' · '), 'weather', weatherIcon(code)];
}

export function postWorkoutHr(cloud) {
  const hr = cloud.summary?.heartRateRecovery;
  if (!hr || typeof hr !== 'object' || Array.isArray(hr)) return null;
  if (!Object.hasOwn(ratings, hr.comparisonLevel) || !number(hr.drop)) return ['—', '', 'unknown'];
  const change = (hr.drop > 0 ? '+' : '') + String(hr.drop).replace('-', '−') + ' bpm';
  return [change, hr.comparisonLevel, ratings[hr.comparisonLevel]];
}

export function workoutTiles(cloud, highlights) {
  const cards = [];
  if (highlights.temperature_c !== null) {
    const shown = Number(fixed(highlights.temperature_c, 1));
    const [palette, label] = shown < 10 ? ['cold', 'Cold'] : shown >= 30 ? ['red', 'Hot'] : ['mild', 'Mild'];
    cards.push(['Average workout temperature', fixed(shown, 1) + ' °C', 'Watch sensor', label, palette, '']);
  }
  const weather = weatherCard(cloud.weather ?? {});
  if (weather) cards.push(weather);
  const hr = postWorkoutHr(cloud);
  if (hr) {
    const [change, rating, palette] = hr;
    cards.push(['Post-workout HR change', change, rating ? 'Suunto comparison' : 'No rated result from Suunto',
      rating, palette, '']);
  }
  if (highlights.recovery_seconds !== null) {
    const [duration, kind, until] = recoveryLabels(highlights);
    cards.push(['Recovery time', duration, until, `Suunto · ${kind.toLowerCase()}`, 'recovery', '']);
  }
  if (!cards.length) return { lines: [], height: 0 };
  const width = Math.min(260, (PLOT_WIDTH - 10 * (cards.length - 1)) / cards.length);
  const lines = ['<g data-section="workout-tiles">'];
  for (let index = 0; index < cards.length; index++) {
    const [name, main, detail, footer, palette, icon] = cards[index];
    const [background, foreground, border] = palettes[palette];
    lines.push(`<g data-workout-tile="${escape(name)}" data-status="${palette}" transform="translate(${LEFT + index * (width + 10)} 95)">`,
      `<rect width="${width}" height="116" rx="9" fill="${background}" stroke="${border}"/>`,
      `<text x="14" y="24" font-size="13" fill="#526170">${escape(name)}</text>`,
      `<text x="14" y="56" font-size="24" font-weight="bold" fill="${foreground}">${escape(main)}</text>`);
    if (detail) lines.push(`<text x="14" y="79" font-size="13" fill="#526170">${escape(detail)}</text>`);
    if (footer) lines.push(`<text x="14" y="101" font-size="12" font-weight="bold" fill="${foreground}">${escape(footer)}</text>`);
    if (icon) lines.push(`<g data-weather-icon="" aria-hidden="true" transform="translate(${width - 73} 17)">${icon}</g>`);
    lines.push('</g>');
  }
  lines.push('</g>');
  return { lines, height: 141 };
}
