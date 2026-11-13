#!/usr/bin/env python3
"""Fetch Suunto workout-list JSON using the locally saved OAuth access token."""

import argparse
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from suunto_cloud.authentication.oauth import NoRedirect
from suunto_cloud.authentication.access import AccessError, authorized_call, safe_error
from suunto_cloud.storage.local import private_directory, private_json

WORKOUTS_URL = "https://cloudapi.suunto.com/v2/workouts"


def fetch_workouts(access_token, subscription_key):
    request = Request(WORKOUTS_URL, headers={
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


def save_workouts(data):
    return private_json(private_directory() / 'workouts.json', data)


def main(argv=None):
    argparse.ArgumentParser(description=__doc__).parse_args(argv)
    data = authorized_call(fetch_workouts)
    records = workout_records(data)
    destination = save_workouts(data)
    print(f"HTTP 200 — Cloud API read succeeded. Data saved to: {destination}")
    print(f"Records in this response: {len(records)}")
    print("This is a workout list response; FIT files and the complete history were not downloaded.")


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
