"""Regenerate workout charts from a saved report and decoded FIT, without network access."""

import argparse
import json
import math
from pathlib import Path
import sys

from suunto_cloud.reporting.reports import cleanup_charts, write_outputs
from suunto_cloud.analysis.sleep import recovery_context
from suunto_cloud.storage.sleep import read_sleep


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
    report = json.loads(args.report.read_text())
    decoded = json.loads(Path(report['source']['decoded_path']).read_text())
    project = args.report.resolve().parent.parent
    recovery = (recovery_context(report['cloud'], read_sleep(args.sleep_data, required=True))
                if args.sleep_data else report.get('recovery'))
    outputs = write_outputs(project, report['cloud'], report['fit'], decoded,
                            report['source'], report['retrieved_at_utc'], charts=True,
                            hr_range=args.hr_range, recovery=recovery)
    cleanup_charts(project / 'visualizations', {outputs['chart_path']})
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
