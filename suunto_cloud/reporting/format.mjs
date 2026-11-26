// Python formats the binary value and rounds exact ties to the even digit.
export function fixed(value, digits = 0) {
  const half = Math.abs(value) * 2 ** (digits + 1);
  if (Number.isSafeInteger(half) && half % 2 === 1) {
    const scale = 10 ** digits;
    const floor = Math.floor(Math.abs(value) * scale);
    if (floor % 2 === 0) return (value < 0 ? '-' : '') + (floor / scale).toFixed(digits);
  }
  return Object.is(value, -0) ? '-' + (0).toFixed(digits) : value.toFixed(digits);
}

export const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;',
}[char]));

export function duration(value) {
  if (!Number.isFinite(value)) return '—';
  const seconds = Number(fixed(value, 1));
  return `${Math.floor(seconds / 60)}:${fixed(((seconds % 60) + 60) % 60, 1).padStart(4, '0')}`;
}

export function clock(value) {
  if (!Number.isFinite(value)) return '—';
  const seconds = Math.floor(value + .5);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds - hours * 3600) / 60);
  const tail = String(seconds - hours * 3600 - minutes * 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}

export function amount(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  // The source report rounds the shortest decimal representation half-up.
  const [coefficient, exponent = '0'] = Math.abs(value).toString().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const decimal = whole.length + Number(exponent) + digits;
  const text = whole + fraction;
  const rounded = decimal < 0 ? 0n :
    BigInt(text.slice(0, decimal).padEnd(decimal, '0') || '0') + (Number(text[decimal]) >= 5 ? 1n : 0n);
  const padded = rounded.toString().padStart(digits + 1, '0');
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  return sign + (digits ? padded.slice(0, -digits) + '.' + padded.slice(-digits) : padded);
}
