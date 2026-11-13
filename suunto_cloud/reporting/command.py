"""Regenerate workout charts from a saved report and decoded FIT, without network access."""

import argparse
import json
from pathlib import Path
import sys

from suunto_cloud.reporting.reports import cleanup_charts, write_outputs


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='Saved JSON report in the reports directory')
    args = parser.parse_args(argv)
    report = json.loads(args.report.read_text())
    decoded = json.loads(Path(report['source']['decoded_path']).read_text())
    project = args.report.resolve().parent.parent
    outputs = write_outputs(project, report['cloud'], report['fit'], decoded,
                            report['source'], report['retrieved_at_utc'], charts=True)
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
