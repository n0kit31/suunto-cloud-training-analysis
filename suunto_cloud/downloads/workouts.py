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
            raise ValueError("Cloud API zwróciło błąd w odpowiedzi JSON; nie zapisano jej jako treningów.")
        records = data.get("payload")
    else:
        records = data
    if not isinstance(records, list) or any(not isinstance(w, dict) for w in records):
        raise ValueError("Nieznana struktura odpowiedzi listy treningów.")
    return records


def save_workouts(data):
    return private_json(private_directory() / 'workouts.json', data)


def main(argv=None):
    argparse.ArgumentParser(description=__doc__).parse_args(argv)
    data = authorized_call(fetch_workouts)
    records = workout_records(data)
    destination = save_workouts(data)
    print(f"HTTP 200 — odczyt Cloud API działa. Zapisano dane: {destination}")
    print(f"Liczba rekordów w tej odpowiedzi: {len(records)}")
    print("To odpowiedź listy treningów, bez pobierania plików FIT ani całej historii.")


def run(argv=None):
    try:
        main(argv)
    except KeyboardInterrupt:
        print("\nPrzerwano.", file=sys.stderr)
        return 130
    except HTTPError as exc:
        with exc:
            body = exc.read(4096).decode("utf-8", errors="replace").lower()
        message = f"Cloud API zwróciło HTTP {exc.code}."
        if "invalid subscription key" in body or "missing subscription key" in body:
            message += " Sprawdź Primary/Secondary Key oraz aktywność subskrypcji Developer API."
        elif exc.code == 401:
            message += " API odrzuciło uwierzytelnienie. Sprawdź ważność tokenu i klucz subskrypcji."
        elif exc.code == 403:
            message += " Sprawdź uprawnienia aplikacji i subskrypcję Developer API."
        elif exc.code == 429:
            message += " Osiągnięto limit wywołań Developer API; ponów próbę później."
        print(message, file=sys.stderr)
        return 1
    except (AccessError, OSError, ValueError, URLError, EOFError) as exc:
        print(safe_error(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(run())
