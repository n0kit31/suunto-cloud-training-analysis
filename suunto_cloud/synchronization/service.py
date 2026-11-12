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
from zoneinfo import ZoneInfo

from suunto_cloud.authentication.access import AccessError, authorized_call, configure, safe_error
from suunto_cloud.storage.local import ROOT, private_directory, private_json
from suunto_cloud.fit import SCRIPTS_DIRECTORY
from suunto_cloud.downloads.workouts import fetch_workouts, save_workouts, workout_records
from suunto_cloud.downloads.tracks import choose_workout, fetch_fit, save_fit
from suunto_cloud.analysis.fit import summarize
from suunto_cloud.analysis.packet import build_packet, brief_packet, cloud_metrics
from suunto_cloud.reporting.reports import write_outputs, cleanup_charts


def sync(dates, decode=True, analysis=False, brief=False, charts=False):
    if analysis and not decode:
        raise ValueError('Tryb --analysis wymaga dekodowania FIT; usuń --no-decode.')
    if brief and not analysis:
        raise ValueError('Tryb --brief wymaga --analysis.')
    if charts and not analysis:
        raise ValueError('Tryb --charts wymaga --analysis.')
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
        start = datetime.fromtimestamp(workout['startTime'] / 1000, ZoneInfo('Europe/Warsaw'))
        if start.date() in wanted:
            selected.append((start, workout))
    found = {start.date() for start, _ in selected}
    missing = sorted(str(day) for day in wanted - found)
    manifest = {'retrieved_at_utc': datetime.now(timezone.utc).isoformat(),
                'requested_dates': sorted(dates), 'missing_dates': missing, 'workouts': [], 'complete': False}
    manifest['timings_seconds'] = {'list': round(perf_counter() - started, 4)}
    manifest_path = private_directory() / 'sync.json'
    private_json(manifest_path, manifest)
    if not selected:
        raise AccessError('Brak treningów dla wskazanych dat w świeżej odpowiedzi API. Nie zastąpiono ich starym zapisem.')
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
        progress(f'Pobieram FIT: {start.date()}, {workout.get("totalDistance", 0) / 1000:.3f} km...')
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
                    raise AccessError('FIT zapisany, lecz dekoder nie zakończył pracy. Sprawdź Node.js i fit-file-parser.')
                # Do not mark decoding successful merely because an old output file exists.
                decoded = json.loads(decoded_path.read_text())
                entry.update({'decoded': True, 'decoded_path': str(decoded_path)})
                entry['timings_seconds']['decode'] = round(perf_counter() - decode_started, 4)
                if analysis:
                    analyze_started = perf_counter()
                    try:
                        analyses[key] = summarize(decoded)
                    except (KeyError, IndexError, TypeError) as error:
                        raise AccessError('FIT zdekodowano, lecz brakuje danych wymaganych do analizy.') from error
                    analysis_path = fit_path.with_suffix('.analysis.json')
                    private_json(analysis_path, analyses[key])
                    entry.update({'analyzed': True, 'analysis_path': str(analysis_path)})
                    entry['timings_seconds']['analysis'] = round(perf_counter() - analyze_started, 4)
            progress(f'Zapisano FIT{ " i pełne próbki JSON" if decode else ""}: {start.date()}.')
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
            entry['outputs'] = write_outputs(ROOT.parent, cloud_metrics(by_key[key]), analyses[key],
                                             json.loads(Path(entry['decoded_path']).read_text()),
                                             entry, manifest['retrieved_at_utc'], charts=charts)
            entry['timings_seconds']['outputs'] = round(perf_counter() - output_started, 4)
        manifest['removed_old_charts'] = cleanup_charts(
            ROOT.parent / 'visualizations', {entry['outputs']['chart_path'] for entry in manifest['workouts']}) if charts else []
        packet = build_packet(manifest, records, analyses)
        packet_path = private_directory() / 'analysis.json'
        private_json(packet_path, packet)
        manifest['analysis_packet_path'] = str(packet_path)
    manifest['timings_seconds']['total'] = round(perf_counter() - started, 4)
    private_json(manifest_path, manifest)
    if missing:
        print('Brak wskazanych dat w bieżącej paczce API: ' + ', '.join(missing), file=sys.stderr)
    if not manifest['complete']:
        raise AccessError('Pobieranie niepełne. Szczegóły bez kluczy zapisano w .local/sync.json.')
    if packet is not None:
        print(json.dumps(brief_packet(packet) if brief else packet, ensure_ascii=False, separators=(',', ':')))
    else:
        progress(f'Gotowe: {len(selected)} aktywności. Manifest: {manifest_path}')
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', action='append', required=True, help='Data Europe/Warsaw; można podać wielokrotnie')
    parser.add_argument('--configure', action='store_true', help='Najpierw jednorazowo zapisz klucze')
    parser.add_argument('--no-decode', action='store_true', help='Zapisz FIT bez dekodowania do JSON')
    parser.add_argument('--analysis', action='store_true',
                        help='Pobierz i przeanalizuj FIT; wypisz tylko zwięzły pakiet JSON dla analizy')
    parser.add_argument('--brief', action='store_true',
                        help='Z --analysis wypisz krótki widok; pełne dane i raporty pozostają w plikach')
    parser.add_argument('--charts', action='store_true',
                        help='Z --analysis generuj także wykresy; wyłącznie na prośbę użytkownika')
    args = parser.parse_args(argv)
    for day in args.date:
        date.fromisoformat(day)  # Validate before credentials/network requests.
    if args.configure:
        configure()
    sync(args.date, decode=not args.no_decode, analysis=args.analysis, brief=args.brief, charts=args.charts)


def run(argv=None):
    try:
        main(argv)
    except KeyboardInterrupt:
        print('\nPrzerwano.', file=sys.stderr)
        return 130
    except (AccessError, OSError, ValueError, URLError, EOFError) as error:
        print(safe_error(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(run())
