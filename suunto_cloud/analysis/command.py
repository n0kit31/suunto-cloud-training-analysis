"""Read a decoded FIT file and print its training analysis."""

import argparse
import json
from pathlib import Path
import sys

from suunto_cloud.analysis.fit import summarize


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='Decoded FIT data in JSON format')
    args = parser.parse_args(argv)
    print(json.dumps(summarize(json.loads(args.input.read_text())), ensure_ascii=False, indent=2))


def run(argv=None):
    try:
        main(argv)
    except KeyboardInterrupt:
        print('\nInterrupted.', file=sys.stderr)
        return 130
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'Analysis failed ({type(error).__name__}).', file=sys.stderr)
        return 1
    return 0
