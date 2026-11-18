"""Analyze a local workout FIT file offline and save a report."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from suunto_cloud.activities import activity_label
from suunto_cloud.analysis.fit import stamp, summarize
from suunto_cloud.analysis.metrics import number
from suunto_cloud.analysis.packet import cloud_metrics
from suunto_cloud.fit import decode_fit
from suunto_cloud.reporting.reports import write_outputs
from suunto_cloud.storage.local import ROOT, private_directory, user_timezone


def fit_summary(decoded, zone):
    sessions = decoded.get('sessions', [])
    if len(sessions) != 1 or not sessions[0].get('start_time'):
        raise ValueError('Import requires a workout FIT with one session and a start time.')
    session = sessions[0]
    start = stamp(session['start_time']).timestamp() * 1000
    elapsed = session.get('total_elapsed_time')
    stop = start + elapsed * 1000 if number(elapsed) else (
        stamp(session['timestamp']).timestamp() * 1000 if session.get('timestamp') else None)
    return cloud_metrics({
        'workoutKey': None, 'activityName': activity_label({}, decoded),
        'startTime': start, 'stopTime': stop,
        'totalDistance': session.get('total_distance'), 'totalTime': session.get('total_timer_time'),
        'totalAscent': session.get('total_ascent'), 'totalDescent': session.get('total_descent'),
        'energyConsumption': session.get('total_calories'),
        'hrdata': {'workoutAvgHR': session.get('avg_heart_rate'), 'workoutMaxHR': session.get('max_heart_rate')},
    }, zone)


def import_fit(source, zone=None, charts=False):
    source = source.resolve(strict=True)
    tracks = private_directory() / 'tracks'
    tracks.mkdir(mode=0o700, exist_ok=True)
    with TemporaryDirectory(dir=tracks) as directory:
        snapshot = Path(directory) / 'input.fit'
        temporary = Path(directory) / 'workout.decoded.json'
        digest = hashlib.sha256()
        with source.open('rb') as original, snapshot.open('wb') as copy:
            for chunk in iter(lambda: original.read(1024 * 1024), b''):
                digest.update(chunk)
                copy.write(chunk)
        sha256 = digest.hexdigest()
        decoded = decode_fit(snapshot, temporary)
        cloud = fit_summary(decoded, zone)
        analysis = summarize(decoded, zone)
        decoded_path = tracks / f'fit-{sha256}.decoded.json'
        temporary.replace(decoded_path)
    entry = {'fit_path': str(source), 'fit_sha256': sha256, 'decoded_path': str(decoded_path),
             'source_type': 'local_fit'}
    return write_outputs(ROOT.parent, cloud, analysis, decoded, entry,
                         datetime.now(timezone.utc).isoformat(), charts=charts)


def run(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='Path to a workout FIT file')
    parser.add_argument('--charts', action='store_true', help='Also save interactive HTML and SVG charts')
    args = parser.parse_args(argv)
    try:
        print(json.dumps(import_fit(args.input, user_timezone(), charts=args.charts), ensure_ascii=False))
    except KeyboardInterrupt:
        print('\nInterrupted.', file=sys.stderr)
        return 130
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        print(f'FIT import failed: {error}', file=sys.stderr)
        return 1
    return 0
