import type { Language } from '../../shared/language';

const locales = { en: 'en-GB', pl: 'pl-PL' };
const numbers = {
  en: [new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }), new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })],
  pl: [new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }), new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 })],
};

export const missing = '—';

export function formatDates(timeZone?: string, language: Language = 'en') {
  const locale = locales[language];
  const compact = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short', year: 'numeric' });
  const full = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit' });
  const dateLabel = (value: number) => compact.format(value);
  const dateLong = (value: number) => full.format(value);
  const timeLabel = (value: number) => clock.format(value);
  const dateTime = (value: number) => `${dateLabel(value)}, ${timeLabel(value)}`;
  return { dateLabel, dateLong, timeLabel, dateTime };
}

export type DateLabels = ReturnType<typeof formatDates>;

export function numeric(value: unknown, unit = '', whole = false, language: Language = 'en') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return missing;
  return `${numbers[language][whole ? 1 : 0].format(value)}${unit ? `\u00a0${unit}` : ''}`;
}

export function distance(value: unknown, language: Language = 'en') {
  return typeof value === 'number' ? numeric(value / 1000, 'km', false, language) : missing;
}

export function duration(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return missing;
  const seconds = Math.round(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const last = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${last}` : `${minutes}:${last}`;
}

export function pace(value: unknown) {
  const time = duration(value);
  return time === missing ? time : `${time}\u00a0min/km`;
}

export { normalizeSport, sportLabel } from '../../shared/language';

export function observationText(text: string, language: Language) {
  if (language === 'en') return text;
  // The analyzer stores observations in these fixed templates, including in older analyses.
  return text
    .replace(/^(.+?) km in (.+?) of active time \((.+?)\), with average \/ maximum heart rate (.+?) bpm\.$/,
      '$1 km w czasie aktywnym $2 ($3). Tętno średnie / maksymalne $4 ud./min.')
    .replace(/ m ascent/g, ' m podejść')
    .replace(/^The kilometre splits show (.+?) faster 1 km segments at (.+?), alternating with slower kilometres at (.+?)\./,
      'Okrążenia pokazują $1 szybszych odcinków kilometrowych w tempie $2 na zmianę z wolniejszymi kilometrami w tempie $3.')
    .replace('Terrain may influence these pace differences.', 'Różnice tempa mogą wynikać z ukształtowania terenu.')
    .replace('Most classified heart-rate time was in zones 1–2.', 'Większość zarejestrowanego czasu przypadła na strefy tętna 1–2.')
    .replace(/^Recorded time in heart-rate zones 4–5 was (.+)\.$/, 'Czas w strefach tętna 4–5 wyniósł $1.')
    .replace('Recorded workout feeling:', 'Zapisane samopoczucie po treningu:')
    .replace('Average workout temperature:', 'Średnia temperatura podczas treningu:')
    .replace('(watch sensor)', '(czujnik zegarka)')
    .replace('Suunto recovery time:', 'Czas regeneracji według Suunto:')
    .replace('(workout estimate)', '(szacunek po treningu)')
    .replace('(accumulated estimate)', '(łączny szacunek)')
    .replace(' · Until ', ' · Do ')
    .replace(/(\d)\.(?=\d)/g, '$1,');
}
