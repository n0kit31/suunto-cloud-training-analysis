#!/usr/bin/env python3
"""Generate the README test-count badge from unittest discovery, or check it in CI."""

import argparse
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
BADGE = ROOT / 'docs' / 'badges' / 'tests.svg'


def render(count):
    message = str(count)
    left, right = 40, max(30, 14 + 7 * len(message))
    width = left + right
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="20" role="img" aria-label="tests: {message}">
  <title>tests: {message}</title>
  <linearGradient id="shade" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="rounded"><rect width="{width}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#rounded)">
    <path fill="#555" d="M0 0h{left}v20H0z"/>
    <path fill="#007ec6" d="M{left} 0h{right}v20H{left}z"/>
    <path fill="url(#shade)" d="M0 0h{width}v20H0z"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
    <text x="{left / 2}" y="15" fill="#010101" fill-opacity=".3">tests</text>
    <text x="{left / 2}" y="14">tests</text>
    <text x="{left + right / 2}" y="15" fill="#010101" fill-opacity=".3">{message}</text>
    <text x="{left + right / 2}" y="14">{message}</text>
  </g>
</svg>
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if the saved badge needs updating')
    args = parser.parse_args()
    loader = unittest.TestLoader()
    suite = loader.discover(str(ROOT / 'tests'), top_level_dir=str(ROOT))
    if loader.errors:
        raise SystemExit('Test discovery failed. Run the test suite for details.')
    count = suite.countTestCases()
    if not count:
        raise SystemExit('No tests discovered; refusing to generate an empty badge.')
    expected = render(count)
    if args.check:
        if not BADGE.is_file() or BADGE.read_text() != expected:
            raise SystemExit('Test count badge is outdated. Run python3 scripts/update-test-badge.py and commit the result.')
        print(f'Test count badge is current: {count} tests.')
    else:
        BADGE.parent.mkdir(parents=True, exist_ok=True)
        BADGE.write_text(expected)
        print(f'Updated docs/badges/tests.svg: {count} tests.')


if __name__ == '__main__':
    main()
