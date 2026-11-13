#!/usr/bin/env python3
"""Download a recorded workout FIT and convert its actual GPS points to GPX."""

import argparse
from datetime import date
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

from suunto_cloud.downloads.workouts import workout_records
from suunto_cloud.authentication.oauth import NoRedirect
from suunto_cloud.authentication.access import AccessError, authorized_call, safe_error
from suunto_cloud.storage.local import private_directory, user_timezone
from suunto_cloud.timezones import local_timestamp
from suunto_cloud.fit import SCRIPTS_DIRECTORY


def choose_workout(records, selected_date=None, workout_key=None, zone=None):
    if workout_key:
        matches = [w for w in records if w.get('workoutKey') == workout_key]
    else:
        matches = [w for w in records if 'LOCATIONSTREAM' in w.get('extensionTypes', [])]
        if selected_date:
            day = date.fromisoformat(selected_date)
            matches = [w for w in matches if local_timestamp(w['startTime'] / 1000, zone).date() == day]
    if not matches:
        raise ValueError('No workout with a GPS track found in the saved list.')
    if (selected_date or workout_key) and len(matches) != 1:
        raise ValueError('Multiple workouts found; select a specific --workout-key from workouts.json.')
    workout = max(matches, key=lambda w: w['startTime'])
    if not re.fullmatch(r'[0-9a-fA-F]{24}', workout.get('workoutKey', '')):
        raise ValueError('Invalid workoutKey in the saved API response.')
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
            raise ValueError('Unsupported FIT download redirect.')
        # A signed download URL is fetched without either authentication header.
        response = opener.open(Request(location, headers={'Accept': 'application/octet-stream'}), timeout=30)
    with response:
        data = response.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise ValueError('Response exceeded the 64 MiB limit.')
    if len(data) < 12 or data[8:12] != b'.FIT':
        raise ValueError('Suunto did not return a binary FIT file; the response was not saved as a track.')
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--date', help="Workout date in the user's time zone, e.g. 2026-11-03")
    selection.add_argument('--workout-key', help='workoutKey from the local workout list')
    selection.add_argument('--input', type=Path, help='Convert a local FIT file without calling the API')
    parser.add_argument('--fit-only', action='store_true', help='Save only the FIT file, without GPX conversion')
    args = parser.parse_args(argv)
    if not args.fit_only and not shutil.which('node'):
        raise ValueError('Node.js is required for the local FIT decoder. You can use --fit-only instead.')
    output_dir = private_directory() / 'tracks'
    if args.input:
        fit_path = args.input.resolve(strict=True)
        output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        gpx_path = output_dir / (fit_path.stem + '.gpx')
    else:
        zone = user_timezone()
        records = workout_records(json.loads((private_directory() / 'workouts.json').read_text()))
        workout = choose_workout(records, args.date, args.workout_key, zone)
        local_start = local_timestamp(workout['startTime'] / 1000, zone)
        stem = local_start.strftime('%Y-%m-%d-%H%M%S')
        fit_path = output_dir / (stem + '.fit')
        gpx_path = output_dir / (stem + '.gpx')
        print(f"Downloading workout FIT: {local_start.isoformat()}, {workout.get('totalDistance', 0) / 1000:.3f} km...", flush=True)
        data = authorized_call(lambda token, key: fetch_fit(workout['workoutKey'], token, key))
        save_fit(fit_path, data)
        print(f'FIT saved to: {fit_path}', flush=True)
    if not args.fit_only:
        result = subprocess.run(['node', str(SCRIPTS_DIRECTORY / 'export_gpx.cjs'), str(fit_path), str(gpx_path)], check=False)
        if result.returncode:
            raise ValueError(f'GPX conversion failed. The original FIT is saved at {fit_path}.')


def run(argv=None):
    try:
        main(argv)
    except KeyboardInterrupt:
        print('\nInterrupted.', file=sys.stderr)
        return 130
    except HTTPError as exc:
        with exc:
            body = exc.read(4096).decode('utf-8', errors='replace').lower()
        hint = 'Check token validity and the Developer API subscription.'
        if 'operationnotfound' in body or exc.code == 404:
            hint = 'The FIT v3 endpoint is unavailable. Use the Request URL for export-workout-fit from API Zone.'
        elif 'ratelimitexceeded' in body or exc.code == 429:
            hint = 'API rate limit reached. Try again later.'
        print(f'FIT download: HTTP {exc.code}. {hint}', file=sys.stderr)
        return 1
    except (AccessError, OSError, ValueError, URLError, EOFError) as exc:
        # Avoid exposing signed redirect URLs or request headers through errors.
        print(safe_error(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(run())
