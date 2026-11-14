#!/usr/bin/env python3
"""Fetch fresh Cloud summaries, FIT and decoded measurements for selected local dates."""

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from time import perf_counter
from urllib.error import URLError

from suunto_cloud.authentication.access import AccessError, authorized_call, configure, safe_error
from suunto_cloud.storage.local import ROOT, private_directory, private_json, user_timezone
from suunto_cloud.timezones import local_timestamp, timezone_name
from suunto_cloud.fit import SCRIPTS_DIRECTORY
from suunto_cloud.downloads.workouts import fetch_workouts, save_workouts, workout_records
from suunto_cloud.downloads.tracks import choose_workout, fetch_fit, save_fit
from suunto_cloud.analysis.fit import summarize
from suunto_cloud.analysis.packet import build_packet, brief_packet, cloud_metrics
from suunto_cloud.analysis.sleep import recovery_context
from suunto_cloud.storage.sleep import read_sleep
from suunto_cloud.reporting.reports import write_outputs, cleanup_charts


def sync(dates, decode=True, analysis=False, brief=False, charts=False, zone=None, sleep_data=None):
    if analysis and not decode:
        raise ValueError('--analysis requires FIT decoding; remove --no-decode.')
    if brief and not analysis:
        raise ValueError('--brief requires --analysis.')
    if charts and not analysis:
        raise ValueError('--charts requires --analysis.')
    if sleep_data is not None and not analysis:
        raise ValueError('--sleep-data requires --analysis.')
    sleep = read_sleep(sleep_data or private_directory() / 'sleep.json',
                       required=sleep_data is not None) if analysis else None
    started = perf_counter()

    def progress(message):
        if not analysis:
            print(message, flush=True)

    wanted = {date.fromisoformat(day) for day in dates}
    data = authorized_call(fetch_workouts)
    records = workout_records(data)
    save_workouts(data)  # Only replace the cache after a successful, validated API response.
    selected = []
    for workout in records:
        start = local_timestamp(workout['startTime'] / 1000, zone)
        if start.date() in wanted:
            selected.append((start, workout))
    found = {start.date() for start, _ in selected}
    missing = sorted(str(day) for day in wanted - found)
    manifest = {'retrieved_at_utc': datetime.now(timezone.utc).isoformat(),
                'requested_dates': sorted(dates), 'timezone': timezone_name(zone),
                'missing_dates': missing, 'workouts': [], 'complete': False}
    manifest['timings_seconds'] = {'list': round(perf_counter() - started, 4)}
    manifest_path = private_directory() / 'sync.json'
    private_json(manifest_path, manifest)
    if not selected:
        raise AccessError('No workouts for the requested dates in the fresh API response. Cached data was not substituted.')
    failed = False
    analyses = {}
    for start, workout in sorted(selected, key=lambda item: item[0]):
        key = workout['workoutKey']
        # Reuse the strict ID validation used by the FIT downloader.
        choose_workout([workout], workout_key=key)
        summary_path = private_directory() / 'workouts' / (key + '.json')
        private_json(summary_path, workout)
        stem = start.strftime('%Y-%m-%d-%H%M%S')
        fit_path = private_directory() / 'tracks' / (stem + '.fit')
        decoded_path = fit_path.with_suffix('.decoded.json')
        entry = {'workout_key': key, 'date': start.date().isoformat(),
                 'cloud_summary_path': str(summary_path), 'fit_downloaded': False, 'decoded': False}
        manifest['workouts'].append(entry)
        private_json(manifest_path, manifest)
        progress(f'Downloading FIT: {start.date()}, {workout.get("totalDistance", 0) / 1000:.3f} km...')
        try:
            fit_started = perf_counter()
            content = authorized_call(lambda token, subkey: fetch_fit(key, token, subkey))
            save_fit(fit_path, content)
            entry.update({'fit_path': str(fit_path), 'fit_downloaded': True,
                          'fit_bytes': len(content), 'fit_sha256': hashlib.sha256(content).hexdigest()})
            entry['timings_seconds'] = {'fit_download': round(perf_counter() - fit_started, 4)}
            if decode:
                decode_started = perf_counter()
                result = subprocess.run(['node', str(SCRIPTS_DIRECTORY / 'decode.cjs'), str(fit_path), str(decoded_path)],
                                        check=False, capture_output=True)
                if result.returncode:
                    raise AccessError('FIT saved, but decoding failed. Check Node.js and fit-file-parser.')
                # Do not mark decoding successful merely because an old output file exists.
                decoded = json.loads(decoded_path.read_text())
                entry.update({'decoded': True, 'decoded_path': str(decoded_path)})
                entry['timings_seconds']['decode'] = round(perf_counter() - decode_started, 4)
                if analysis:
                    analyze_started = perf_counter()
                    try:
                        analyses[key] = summarize(decoded, zone)
                    except (KeyError, IndexError, TypeError) as error:
                        raise AccessError('FIT decoded, but data required for analysis is missing.') from error
                    analysis_path = fit_path.with_suffix('.analysis.json')
                    private_json(analysis_path, analyses[key])
                    entry.update({'analyzed': True, 'analysis_path': str(analysis_path)})
                    entry['timings_seconds']['analysis'] = round(perf_counter() - analyze_started, 4)
            progress(f'Saved FIT{ " and full JSON samples" if decode else ""}: {start.date()}.')
        except (AccessError, OSError, ValueError, URLError) as error:
            entry['error'] = safe_error(error)
            failed = True
            print(entry['error'], file=sys.stderr)
        finally:
            private_json(manifest_path, manifest)
    manifest['complete'] = not failed and not missing
    packet = None
    if analysis and manifest['complete']:
        by_key = {workout['workoutKey']: workout for workout in records}
        for entry in manifest['workouts']:
            output_started = perf_counter()
            key = entry['workout_key']
            cloud = cloud_metrics(by_key[key], zone)
            entry['recovery'] = recovery_context(cloud, sleep)
            entry['outputs'] = write_outputs(ROOT.parent, cloud, analyses[key],
                                             json.loads(Path(entry['decoded_path']).read_text()),
                                             entry, manifest['retrieved_at_utc'], charts=charts,
                                             recovery=entry['recovery'])
            entry['timings_seconds']['outputs'] = round(perf_counter() - output_started, 4)
        manifest['removed_old_charts'] = cleanup_charts(
            ROOT.parent / 'visualizations', {entry['outputs']['chart_path'] for entry in manifest['workouts']}) if charts else []
        packet = build_packet(manifest, records, analyses, zone)
        packet_path = private_directory() / 'analysis.json'
        private_json(packet_path, packet)
        manifest['analysis_packet_path'] = str(packet_path)
    manifest['timings_seconds']['total'] = round(perf_counter() - started, 4)
    private_json(manifest_path, manifest)
    if missing:
        print('Requested dates missing from the current API response: ' + ', '.join(missing), file=sys.stderr)
    if not manifest['complete']:
        raise AccessError('Download incomplete. Details without credentials saved to .local/sync.json.')
    if packet is not None:
        print(json.dumps(brief_packet(packet) if brief else packet, ensure_ascii=False, separators=(',', ':')))
    else:
        progress(f'Completed: {len(selected)} activities. Manifest: {manifest_path}')
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', action='append', required=True, help="Date in the user's time zone; may be repeated")
    parser.add_argument('--configure', action='store_true', help='Save credentials first using one-time setup')
    parser.add_argument('--no-decode', action='store_true', help='Save FIT without decoding it to JSON')
    parser.add_argument('--analysis', action='store_true',
                        help='Download and analyze FIT; print only the analysis JSON packet')
    parser.add_argument('--brief', action='store_true',
                        help='With --analysis, print a brief view; full data and reports are saved to files')
    parser.add_argument('--charts', action='store_true',
                        help='With --analysis, also generate charts; only when requested by the user')
    parser.add_argument('--sleep-data', type=Path,
                        help='Private Suunto 247 sleep JSON; defaults to .local/sleep.json when present')
    args = parser.parse_args(argv)
    for day in args.date:
        date.fromisoformat(day)  # Validate before credentials/network requests.
    zone = user_timezone()
    if args.configure:
        configure()
    sync(args.date, decode=not args.no_decode, analysis=args.analysis, brief=args.brief,
         charts=args.charts, zone=zone, sleep_data=args.sleep_data)


def run(argv=None):
    try:
        main(argv)
    except KeyboardInterrupt:
        print('\nInterrupted.', file=sys.stderr)
        return 130
    except (AccessError, OSError, ValueError, URLError, EOFError) as error:
        print(safe_error(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(run())
