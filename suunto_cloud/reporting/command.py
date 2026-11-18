"""Regenerate workout charts from a saved report and decoded FIT, without network access."""

import argparse
import json
import math
from pathlib import Path
import sys

from suunto_cloud.reporting.reports import regenerate_report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='Saved JSON report in the reports directory')
    parser.add_argument('--hr-range', nargs=2, type=float, metavar=('MIN', 'MAX'),
                        help='Heart rate axis limits in bpm')
    parser.add_argument('--sleep-data', type=Path,
                        help='Add/refresh recovery from private Suunto 247 sleep JSON; otherwise retain saved context')
    args = parser.parse_args(argv)
    if args.hr_range is not None:
        lo, hi = args.hr_range
        if not (math.isfinite(lo) and math.isfinite(hi) and 0 <= lo < hi):
            parser.error('--hr-range requires finite limits with 0 <= MIN < MAX')
    outputs = regenerate_report(args.report, hr_range=args.hr_range, sleep_data=args.sleep_data)
    print(json.dumps(outputs, ensure_ascii=False))


def run(argv=None):
    try:
        main(argv)
    except KeyboardInterrupt:
        print('\nInterrupted.', file=sys.stderr)
        return 130
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'Chart generation failed ({type(error).__name__}).', file=sys.stderr)
        return 1
    return 0
