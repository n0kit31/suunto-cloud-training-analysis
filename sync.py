#!/usr/bin/env python3
"""Compatibility entry point for existing sync.py commands."""

import sys

from suunto_cloud.cli import main


if __name__ == '__main__':
    raise SystemExit(main(['sync', *sys.argv[1:]]))
