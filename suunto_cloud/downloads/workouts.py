#!/usr/bin/env python3
"""Fetch Suunto workout-list JSON using the locally saved OAuth access token."""

import argparse
from datetime import date, datetime, time
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener

from suunto_cloud.authentication.oauth import NoRedirect
from suunto_cloud.authentication.access import AccessError, authorized_call, safe_error
from suunto_cloud.storage.local import private_directory, private_json, user_timezone

WORKOUTS_URL = "https://cloudapi.suunto.com/v2/workouts"
PAGE_SIZE = 50
MAX_PAGE_SIZE = 1000
MAX_PAGES = 500


def fetch_workouts(access_token, subscription_key, **query):
    url = WORKOUTS_URL + ('?' + urlencode(query) if query else '')
    request = Request(url, headers={
        "Authorization": "Bearer " + access_token,
        "Ocp-Apim-Subscription-Key": subscription_key,
        "Accept": "application/json",
    }, method="GET")
    with build_opener(NoRedirect).open(request, timeout=30) as response:
        return json.load(response)


def workout_records(data):
    if isinstance(data, dict):
        if data.get("error") is not None:
            raise ValueError("Cloud API returned an error in JSON; the response was not saved as workouts.")
        records = data.get("payload")
    else:
        records = data
    if not isinstance(records, list) or any(not isinstance(w, dict) for w in records):
        raise ValueError("Unrecognized workout list response structure.")
    return records


def date_cutoff(day, zone):
    return int(datetime.combine(day, time.min, tzinfo=zone).timestamp() * 1000)


def paginated_workouts(fetch, *, cutoff=None):
    """Walk descending modification times, overlapping the boundary millisecond."""
    first = fetch()
    page = workout_records(first)
    size = PAGE_SIZE
    until = None
    seen = {}
    for page_number in range(1, MAX_PAGES + 1):
        modified = [workout.get('lastModified') for workout in page]
        if len(page) >= size or until is not None:
            if any(type(value) is not int for value in modified) or modified != sorted(modified, reverse=True):
                raise ValueError('Unexpected Cloud API modification times; cannot continue paging safely.')
            if until is not None and modified and modified[0] >= until:
                raise ValueError('Cloud API ignored the pagination cursor.')
        for workout in page:
            key = workout.get('workoutKey')
            if not isinstance(key, str) or not key:
                raise ValueError('Workout list is missing a workout key.')
            seen.setdefault(key, workout)
        if len(page) < size:
            break
        oldest = modified[-1]
        if cutoff is not None and oldest < cutoff:
            break
        next_until = oldest + 1  # The API's until is exclusive.
        if next_until == until:
            # A full page shares the cursor millisecond. Widen it before moving past the tie.
            if size == MAX_PAGE_SIZE:
                raise ValueError('Workout pagination stalled at one modification time.')
            size = min(size * 2, MAX_PAGE_SIZE)
        else:
            until = next_until
            size = PAGE_SIZE
        if page_number < MAX_PAGES:
            page = workout_records(fetch(until=until, limit=size))
    else:
        raise ValueError('Workout pagination reached its page limit.')
    metadata = (first.get('metadata') or {}) if isinstance(first, dict) else {}
    return {'error': None, 'payload': list(seen.values()),
            'metadata': {**metadata, 'workoutcount': str(len(seen)), 'pages': page_number}}


def save_workouts(data):
    return private_json(private_directory() / 'workouts.json', data)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--since', type=date.fromisoformat, metavar='DATE',
                       help='Include workouts started on or after this local date')
    scope.add_argument('--all', action='store_true', help='Read all workout list pages')
    args = parser.parse_args(argv)
    cutoff = date_cutoff(args.since, user_timezone()) if args.since is not None else None
    if args.all or cutoff is not None:
        data = paginated_workouts(lambda **query: authorized_call(
            lambda token, key: fetch_workouts(token, key, **query)), cutoff=cutoff)
        if cutoff is not None:
            if any(type(w.get('startTime')) is not int for w in data['payload']):
                raise ValueError('Unexpected Cloud API workout start times.')
            data['payload'] = [w for w in data['payload'] if w['startTime'] >= cutoff]
            data['metadata']['workoutcount'] = str(len(data['payload']))
    else:
        data = authorized_call(fetch_workouts)
    records = workout_records(data)
    destination = save_workouts(data)
    print(f"HTTP 200 — Cloud API read succeeded. Data saved to: {destination}")
    print(f"Records in this response: {len(records)}")
    pages = ((data.get('metadata') or {}).get('pages', 1) if isinstance(data, dict) else 1)
    print(f"Workout list pages read: {pages}")


def run(argv=None):
    try:
        main(argv)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    except HTTPError as exc:
        with exc:
            body = exc.read(4096).decode("utf-8", errors="replace").lower()
        message = f"Cloud API returned HTTP {exc.code}."
        if "invalid subscription key" in body or "missing subscription key" in body:
            message += " Check the Primary/Secondary Key and whether the Developer API subscription is active."
        elif exc.code == 401:
            message += " API authentication was rejected. Check token validity and the subscription key."
        elif exc.code == 403:
            message += " Check application permissions and the Developer API subscription."
        elif exc.code == 429:
            message += " Developer API rate limit reached; try again later."
        print(message, file=sys.stderr)
        return 1
    except (AccessError, OSError, ValueError, URLError, EOFError) as exc:
        print(safe_error(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(run())
