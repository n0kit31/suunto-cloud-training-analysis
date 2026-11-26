const formatters = new Map();

export function timestampMs(value) {
  const result = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(result)) throw new TypeError('Invalid workout timestamp.');
  const micros = /\.(\d{3})(\d{1,3})(?:Z|[+-]\d{2}:?\d{2})?$/.exec(value)?.[2];
  return micros ? result + Number(micros.padEnd(3, '0')) / 1000 : result;
}

export function localTimestamp(milliseconds, zone) {
  if (!Number.isFinite(milliseconds)) throw new TypeError('Invalid workout timestamp.');
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
      hourCycle: 'h23', timeZoneName: 'longOffset',
    });
    formatters.set(zone, format);
  }
  let whole = Math.floor(milliseconds);
  let remainder = Math.round((milliseconds - whole) * 1000);
  if (remainder === 1000) {
    whole++;
    remainder = 0;
  }
  const parts = Object.fromEntries(format.formatToParts(whole).map(({ type, value }) => [type, value]));
  const fraction = parts.fractionalSecond === '000' && remainder === 0 ? '' :
    `.${parts.fractionalSecond}${String(remainder).padStart(3, '0')}`;
  const offset = parts.timeZoneName.slice(3) || '+00:00';
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${offset}`;
}
