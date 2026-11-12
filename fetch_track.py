#!/usr/bin/env python3
"""Download a recorded workout FIT and convert its actual GPS points to GPX."""

import argparse
from datetime import date, datetime
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener
from zoneinfo import ZoneInfo

from fetch_workouts import workout_records
from oauth import NoRedirect
from access import AccessError, authorized_call, safe_error

ROOT = Path(__file__).resolve().parent


def choose_workout(records, selected_date=None, workout_key=None):
    if workout_key:
        matches = [w for w in records if w.get('workoutKey') == workout_key]
    else:
        matches = [w for w in records if 'LOCATIONSTREAM' in w.get('extensionTypes', [])]
        if selected_date:
            day = date.fromisoformat(selected_date)
            matches = [w for w in matches if datetime.fromtimestamp(w['startTime'] / 1000, ZoneInfo('Europe/Warsaw')).date() == day]
    if not matches:
        raise ValueError('Nie znaleziono treningu ze śladem GPS w zapisanej liście.')
    if (selected_date or workout_key) and len(matches) != 1:
        raise ValueError('Znaleziono kilka treningów; wybierz konkretny --workout-key z workouts.json.')
    workout = max(matches, key=lambda w: w['startTime'])
    if not re.fullmatch(r'[0-9a-fA-F]{24}', workout.get('workoutKey', '')):
        raise ValueError('Nieprawidłowy workoutKey w zapisanej odpowiedzi API.')
    return workout


def fetch_fit(workout_key, access_token, subscription_key):
    url = 'https://cloudapi.suunto.com/v3/workouts/' + workout_key + '/fit'
    request = Request(url, headers={
        'Authorization': 'Bearer ' + access_token,
        'Ocp-Apim-Subscription-Key': subscription_key,
        'Accept': 'application/octet-stream',
    }, method='GET')
    opener = build_opener(NoRedirect)
    try:
        response = opener.open(request, timeout=30)
    except HTTPError as exc:
        if exc.code not in (301, 302, 303, 307, 308):
            raise
        with exc:
            location = exc.headers.get('Location', '')
        parsed = urlsplit(location)
        host = parsed.hostname or ''
        if (parsed.scheme != 'https' or parsed.username or parsed.password
                or not (host.endswith('.blob.core.windows.net') or host.endswith('.suunto.com'))):
            raise ValueError('Nieobsługiwane przekierowanie pobierania FIT.')
        # A signed download URL is fetched without either authentication header.
        response = opener.open(Request(location, headers={'Accept': 'application/octet-stream'}), timeout=30)
    with response:
        data = response.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise ValueError('Odpowiedź przekroczyła limit 64 MiB.')
    if len(data) < 12 or data[8:12] != b'.FIT':
        raise ValueError('Suunto nie zwróciło binarnego pliku FIT; nie zapisano odpowiedzi jako trasy.')
    return data


def save_fit(destination, data):
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination.parent.chmod(0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='wb', dir=destination.parent, delete=False) as f:
            temporary = Path(f.name)
            f.write(data)
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--date', help='Data treningu w Europe/Warsaw, np. 2026-11-03')
    selection.add_argument('--workout-key', help='workoutKey z lokalnej listy treningów')
    selection.add_argument('--input', type=Path, help='Konwertuj lokalny FIT bez wywołania API')
    parser.add_argument('--fit-only', action='store_true', help='Zapisz sam FIT, bez konwersji do GPX')
    args = parser.parse_args()
    if not args.fit_only and not shutil.which('node'):
        raise ValueError('Brak Node.js, wymaganego przez lokalny dekoder FIT. Możesz użyć --fit-only.')
    output_dir = ROOT / '.local/tracks'
    if args.input:
        fit_path = args.input.resolve(strict=True)
        output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        gpx_path = output_dir / (fit_path.stem + '.gpx')
    else:
        records = workout_records(json.loads((ROOT / '.local/workouts.json').read_text()))
        workout = choose_workout(records, args.date, args.workout_key)
        local_start = datetime.fromtimestamp(workout['startTime'] / 1000, ZoneInfo('Europe/Warsaw'))
        stem = local_start.strftime('%Y-%m-%d-%H%M%S')
        fit_path = output_dir / (stem + '.fit')
        gpx_path = output_dir / (stem + '.gpx')
        print(f"Pobieram FIT treningu {local_start.isoformat()}, {workout.get('totalDistance', 0) / 1000:.3f} km...", flush=True)
        data = authorized_call(lambda token, key: fetch_fit(workout['workoutKey'], token, key))
        save_fit(fit_path, data)
        print(f'Zapisano FIT: {fit_path}', flush=True)
    if not args.fit_only:
        result = subprocess.run(['node', str(ROOT / 'fit_to_gpx.cjs'), str(fit_path), str(gpx_path)], check=False)
        if result.returncode:
            raise ValueError(f'Konwersja GPX nie powiodła się. Oryginalny FIT pozostaje w {fit_path}.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nPrzerwano.', file=sys.stderr)
        sys.exit(130)
    except HTTPError as exc:
        with exc:
            body = exc.read(4096).decode('utf-8', errors='replace').lower()
        hint = 'Sprawdź ważność tokenu i subskrypcję Developer API.'
        if 'operationnotfound' in body or exc.code == 404:
            hint = 'Endpoint FIT v3 nie jest dostępny. Potrzebny jest Request URL operacji export-workout-fit z panelu API Zone.'
        elif 'ratelimitexceeded' in body or exc.code == 429:
            hint = 'Osiągnięto limit API. Ponów próbę później.'
        print(f'Pobieranie FIT: HTTP {exc.code}. {hint}', file=sys.stderr)
        sys.exit(1)
    except (AccessError, OSError, ValueError, URLError, EOFError) as exc:
        # Avoid exposing signed redirect URLs or request headers through errors.
        print(safe_error(exc), file=sys.stderr)
        sys.exit(1)
