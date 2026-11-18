#!/usr/bin/env python3
"""Fetch fresh Cloud summaries, FIT and decoded measurements for selected local dates."""

import argparse
from datetime import date, datetime, timedelta, timezone
import fcntl
import hashlib
import json
from pathlib import Path
import sys
from time import perf_counter
from urllib.error import URLError

from suunto_cloud.authentication.access import AccessError, authorized_call, configure, safe_error
from suunto_cloud.storage.local import ROOT, cloud_artifact_stem, private_directory, private_json, user_timezone
from suunto_cloud.timezones import local_timestamp, timezone_name
from suunto_cloud.fit import decode_fit
from suunto_cloud.downloads.workouts import date_cutoff, fetch_workouts, paginated_workouts, save_workouts, workout_records
from suunto_cloud.downloads.tracks import choose_workout, fetch_fit, save_fit
from suunto_cloud.analysis.fit import summarize
from suunto_cloud.analysis.packet import build_packet, brief_packet, cloud_metrics
from suunto_cloud.analysis.sleep import recovery_context
from suunto_cloud.storage.sleep import read_sleep
from suunto_cloud.reporting.reports import prune_report_charts, write_outputs


STAGE_ERRORS = (AccessError, OSError, ValueError, EOFError, KeyError, IndexError, TypeError, KeyboardInterrupt)


def sync(dates, decode=True, analysis=False, brief=False, charts=False, zone=None, sleep_data=None):
    if analysis and not decode:
        raise ValueError('--analysis requires FIT decoding; remove --no-decode.')
    if brief and not analysis:
        raise ValueError('--brief requires --analysis.')
    if charts and not analysis:
        raise ValueError('--charts requires --analysis.')
    if sleep_data is not None and not analysis:
        raise ValueError('--sleep-data requires --analysis.')
    directory = private_directory()
    sleep = read_sleep(sleep_data or directory / 'sleep.json',
                       required=sleep_data is not None) if analysis else None
    with (directory / 'sync.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise AccessError('Another sync is already running for this project.') from error
        return _synchronize(directory, dates, decode, analysis, brief, charts, zone, sleep)


def _synchronize(directory, dates, decode, analysis, brief, charts, zone, sleep):
    started = perf_counter()

    def progress(message):
        if not analysis:
            print(message, flush=True)

    wanted = {date.fromisoformat(day) for day in dates}
    first_day = min(wanted)
    monday = first_day - timedelta(days=first_day.weekday())
    data = paginated_workouts(lambda **query: authorized_call(
        lambda token, key: fetch_workouts(token, key, **query)), cutoff=date_cutoff(monday, zone))
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
                'workout_list_pages': data['metadata']['pages'], 'missing_dates': missing,
                'workouts': [], 'complete': False}
    manifest['timings_seconds'] = {'list': round(perf_counter() - started, 4)}
    manifest_path = directory / 'sync.json'
    private_json(manifest_path, manifest)
    if not selected:
        raise AccessError('No workouts for the requested dates in the fresh API response. Cached data was not substituted.')
    failed = False
    analyses = {}
    for start, workout in sorted(selected, key=lambda item: item[0]):
        key = workout['workoutKey']
        entry = {'workout_key': key, 'date': start.date().isoformat(),
                 'fit_downloaded': False, 'decoded': False}
        manifest['workouts'].append(entry)
        stage = 'cloud_summary'
        try:
            # Reuse the strict ID validation used by the FIT downloader.
            choose_workout([workout], workout_key=key)
            summary_path = directory / 'workouts' / (key + '.json')
            private_json(summary_path, workout)
            entry['cloud_summary_path'] = str(summary_path)
            private_json(manifest_path, manifest)
            stem = cloud_artifact_stem(start, key)
            fit_path = directory / 'tracks' / (stem + '.fit')
            decoded_path = fit_path.with_suffix('.decoded.json')
            stage = 'fit_download'
            progress(f'Downloading FIT: {start.date()}, {workout.get("totalDistance", 0) / 1000:.3f} km...')
            fit_started = perf_counter()
            content = authorized_call(lambda token, subkey: fetch_fit(key, token, subkey))
            save_fit(fit_path, content)
            entry.update({'fit_path': str(fit_path), 'fit_downloaded': True,
                          'fit_bytes': len(content), 'fit_sha256': hashlib.sha256(content).hexdigest()})
            entry['timings_seconds'] = {'fit_download': round(perf_counter() - fit_started, 4)}
            if decode:
                stage = 'decode'
                decode_started = perf_counter()
                # Do not mark decoding successful merely because an old output file exists.
                decoded = decode_fit(fit_path, decoded_path)
                entry.update({'decoded': True, 'decoded_path': str(decoded_path)})
                entry['timings_seconds']['decode'] = round(perf_counter() - decode_started, 4)
                if analysis:
                    stage = 'analysis'
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
        except STAGE_ERRORS as error:
            entry['failed_stage'] = stage
            entry['error'] = safe_error(error)
            if isinstance(error, KeyboardInterrupt):
                raise
            failed = True
            print(entry['error'], file=sys.stderr)
        finally:
            private_json(manifest_path, manifest)
    packet = None
    try:
        if not failed and not missing:
            if analysis:
                packet = _publish_analysis(directory, manifest_path, manifest, records, analyses, zone, sleep, charts)
            manifest['complete'] = True
    finally:
        manifest['timings_seconds']['total'] = round(perf_counter() - started, 4)
        private_json(manifest_path, manifest)
    if missing:
        print('Requested dates missing from the current API response: ' + ', '.join(missing), file=sys.stderr)
    if not manifest['complete']:
        raise AccessError('Synchronization incomplete. Details saved to .local/sync.json.')
    if packet is not None:
        print(json.dumps(brief_packet(packet) if brief else packet, ensure_ascii=False, separators=(',', ':')))
    else:
        progress(f'Completed: {len(selected)} activities. Manifest: {manifest_path}')
    return manifest


def _publish_analysis(directory, manifest_path, manifest, records, analyses, zone, sleep, charts):
    stage = 'report_context'
    try:
        by_key = {workout['workoutKey']: workout for workout in records}
        comparisons = [cloud_metrics(workout, zone) for workout in records] if charts else None
        stage = 'report'
        for entry in manifest['workouts']:
            output_started = perf_counter()
            key = entry['workout_key']
            try:
                cloud = cloud_metrics(by_key[key], zone)
                entry['recovery'] = recovery_context(cloud, sleep)
                entry['outputs'] = write_outputs(ROOT.parent, cloud, analyses[key],
                                                 json.loads(Path(entry['decoded_path']).read_text()),
                                                 entry, manifest['retrieved_at_utc'], charts=charts,
                                                 recovery=entry['recovery'], week_workouts=comparisons)
            except STAGE_ERRORS as error:
                entry.update(failed_stage=stage, error=safe_error(error))
                raise
            entry['timings_seconds']['outputs'] = round(perf_counter() - output_started, 4)
            private_json(manifest_path, manifest)
        stage = 'chart_cleanup'
        manifest['removed_old_charts'] = prune_report_charts(
            ROOT.parent, [entry['outputs'] for entry in manifest['workouts']]) if charts else []
        stage = 'analysis_packet'
        packet = build_packet({**manifest, 'complete': True}, records, analyses, zone)
        packet_path = directory / 'analysis.json'
        private_json(packet_path, packet)
        manifest['analysis_packet_path'] = str(packet_path)
        return packet
    except STAGE_ERRORS as error:
        manifest.update(failed_stage=stage, error=safe_error(error))
        if isinstance(error, KeyboardInterrupt):
            raise
        raise AccessError(f'Synchronization failed during {stage}. Details saved to .local/sync.json.') from error


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
