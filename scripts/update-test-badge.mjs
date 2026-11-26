import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const badge = new URL('docs/badges/tests.svg', root);
const test = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/**/*.test.mjs'],
  { cwd: fileURLToPath(root), encoding: 'utf8' });
if (test.status !== 0) {
  process.stdout.write(test.stdout || '');
  process.stderr.write(test.stderr || '');
  console.error('The offline test suite failed.');
  process.exitCode = 1;
} else {
  const count = Number(/^# tests (\d+)$/m.exec(test.stdout)?.[1]);
  if (!(count > 0)) throw new Error('No tests discovered.');
  if (process.argv.includes('--check')) {
    if (readFileSync(badge, 'utf8') !== render(count)) throw new Error('Run node scripts/update-test-badge.mjs to update the badge.');
    console.log(`Test count badge is current: ${count} tests.`);
  } else {
    writeFileSync(badge, render(count));
    console.log(`Updated docs/badges/tests.svg: ${count} tests.`);
  }
}

function render(count) {
  const left = 40;
  const right = Math.max(30, 14 + 7 * String(count).length);
  const width = left + right;
  const center = left + right / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="tests: ${count}">
  <title>tests: ${count}</title>
  <linearGradient id="shade" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="rounded"><rect width="${width}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#rounded)">
    <path fill="#555" d="M0 0h${left}v20H0z"/>
    <path fill="#007ec6" d="M${left} 0h${right}v20H${left}z"/>
    <path fill="url(#shade)" d="M0 0h${width}v20H0z"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
    <text x="20" y="15" fill="#010101" fill-opacity=".3">tests</text>
    <text x="20" y="14">tests</text>
    <text x="${center}" y="15" fill="#010101" fill-opacity=".3">${count}</text>
    <text x="${center}" y="14">${count}</text>
  </g>
</svg>
`;
}
