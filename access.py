#!/usr/bin/env python3
"""Private local Suunto credentials, serialized OAuth refresh and authenticated reads."""

import argparse
import base64
import fcntl
import getpass
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener

from oauth import NoRedirect, TOKEN_URL

ROOT = Path(__file__).resolve().parent


class AccessError(RuntimeError):
    pass


def private_directory():
    directory = ROOT / '.local'
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    return directory


def private_json(destination, data):
    destination = Path(destination)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination.parent.chmod(0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=destination.parent,
                                         encoding='utf-8', delete=False) as stream:
            temporary = Path(stream.name)
            os.fchmod(stream.fileno(), 0o600)
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination


def load_config():
    config = json.loads((ROOT / 'config.json').read_text())
    if not isinstance(config, dict) or not isinstance(config.get('client_id'), str) or not config['client_id']:
        raise AccessError('Brak Client ID w config.json.')
    return config


def load_credentials():
    config = load_config()
    path = private_directory() / 'credentials.json'
    credentials = json.loads(path.read_text()) if path.is_file() else {}
    if not isinstance(credentials, dict):
        raise AccessError('Nieprawidłowy format credentials.json.')
    if credentials and credentials.get('client_id') != config['client_id']:
        raise AccessError('Zapisane klucze należą do innego Client ID. Uruchom access.py --configure.')
    for field, variable in [('client_secret', 'SUUNTO_CLIENT_SECRET'),
                             ('subscription_key', 'SUUNTO_SUBSCRIPTION_KEY')]:
        if os.environ.get(variable):
            credentials[field] = os.environ[variable].strip()
        if field in credentials and not isinstance(credentials[field], str):
            raise AccessError('Nieprawidłowy format zapisanych kluczy.')
    credentials['client_id'] = config['client_id']
    return credentials


def configure():
    config = load_config()
    path = private_directory() / 'credentials.json'
    if not sys.stdin.isatty():
        raise AccessError('Konfigurację uruchom w swoim interaktywnym terminalu; nie podawaj kluczy jako argumentów.')
    print('Jednorazowa konfiguracja Suunto. Wpisywane klucze nie będą widoczne.')
    print('Client secret i Primary/Secondary Key pochodzą z profilu https://apizone.suunto.com/profile')
    credentials = {'client_id': config['client_id']}
    for field, prompt in [('client_secret', 'Client secret z OAuth application settings: '),
                           ('subscription_key', 'Primary lub Secondary Key z subskrypcji Developer API: ')]:
        value = getpass.getpass(prompt).strip()
        if not value:
            raise AccessError('Oba klucze są wymagane; nie zmieniono pliku konfiguracji.')
        credentials[field] = value
    private_json(path, credentials)
    print('Zapisano klucze w .local/credentials.json (0600, katalog 0700, poza Git).')
    print('To potwierdza zapis. Połączenie i poprawność kluczy sprawdzi polecenie sync.py.')


def load_tokens():
    path = private_directory() / 'tokens.json'
    if not path.is_file():
        raise AccessError('Brak zapisanych tokenów. Uruchom python3 suunto-cloud/oauth.py.')
    tokens = json.loads(path.read_text())
    if not isinstance(tokens, dict) or tokens.get('client_id') != load_config()['client_id']:
        raise AccessError('Token i konfiguracja mają różne Client ID. Wymagana jest autoryzacja oauth.py.')
    if not isinstance(tokens.get('access_token'), str) or not tokens['access_token']:
        raise AccessError('Brak poprawnego access tokenu. Wymagana jest autoryzacja oauth.py.')
    return tokens


def is_current(tokens, now=None):
    try:
        expiry = float(tokens.get('received_at_unix', 0)) + float(tokens.get('expires_in', 0))
    except (TypeError, ValueError):
        return False
    return expiry > (time.time() if now is None else now) + 120


def refresh_tokens(tokens, credentials):
    refresh = tokens.get('refresh_token')
    if not isinstance(refresh, str) or not refresh:
        raise AccessError('Brak refresh tokenu. Wymagana jest ponowna autoryzacja oauth.py.')
    secret = credentials.get('client_secret')
    if not secret:
        raise AccessError('Brak zapisanego Client secret. Uruchom python3 suunto-cloud/access.py --configure.')
    basic = base64.b64encode(f"{credentials['client_id']}:{secret}".encode()).decode('ascii')
    request = Request(TOKEN_URL, data=urlencode({
        'grant_type': 'refresh_token', 'refresh_token': refresh,
    }).encode('ascii'), headers={
        'Authorization': 'Basic ' + basic,
        'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json',
    }, method='POST')
    try:
        with build_opener(NoRedirect).open(request, timeout=30) as response:
            result = json.load(response)
    except HTTPError as exc:
        with exc:
            try:
                result = json.loads(exc.read(8192))
            except (ValueError, UnicodeError):
                result = {}
        error = result.get('error') if isinstance(result, dict) else None
        if error == 'invalid_grant':
            raise AccessError('Refresh token został odrzucony. Uruchom oauth.py po nową zgodę; nie wklejaj tokenów do rozmowy.') from None
        if error == 'invalid_client' or exc.code == 401:
            raise AccessError('Odświeżanie OAuth: sprawdź Client secret i Client ID; access.py --configure pozwala poprawić zapis.') from None
        raise AccessError(f'Odświeżanie OAuth nie powiodło się: HTTP {exc.code}. Tokeny pozostają bez zmian.') from None
    if not isinstance(result, dict) or not isinstance(result.get('access_token'), str) or not result['access_token']:
        raise AccessError('Nieprawidłowa odpowiedź odświeżania. Tokeny pozostają bez zmian.')
    try:
        expires = int(result.get('expires_in', 0))
    except (ValueError, TypeError):
        expires = 0
    if expires <= 0 or ('refresh_token' in result and
                        (not isinstance(result['refresh_token'], str) or not result['refresh_token'])):
        raise AccessError('Nieprawidłowy czas ważności lub refresh token. Tokeny pozostają bez zmian.')
    # Some servers rotate refresh tokens; others omit the unchanged token.
    updated = {**tokens, **result, 'expires_in': expires,
               'received_at_unix': int(time.time()), 'client_id': credentials['client_id']}
    private_json(private_directory() / 'tokens.json', updated)
    return updated


def get_access_token(force=False, rejected_token=None):
    lock_path = private_directory() / 'auth.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        tokens = load_tokens()
        # Another reader may already have refreshed the token rejected by the API.
        if is_current(tokens) and (not force or (rejected_token is not None and tokens['access_token'] != rejected_token)):
            return tokens['access_token']
        return refresh_tokens(tokens, load_credentials())['access_token']


def authorized_call(operation):
    credentials = load_credentials()
    key = credentials.get('subscription_key', '').strip()
    if not key:
        raise AccessError('Brak zapisanego klucza Developer API. Uruchom python3 suunto-cloud/access.py --configure.')
    token = get_access_token()
    try:
        return operation(token, key)
    except HTTPError as exc:
        if exc.code != 401:
            raise
        with exc:
            body = exc.read(4096).decode('utf-8', errors='replace').lower()
        if 'subscription' in body and ('invalid' in body or 'missing' in body):
            raise AccessError('Cloud API odrzuciło klucz subskrypcji; sprawdź go przez access.py --configure.') from None
    token = get_access_token(force=True, rejected_token=token)
    return operation(token, key)  # One retry only; never an infinite refresh loop.


def status():
    credentials = load_credentials()
    tokens = load_tokens()
    print(json.dumps({
        'client_secret_saved_or_in_environment': bool(credentials.get('client_secret')),
        'subscription_key_saved_or_in_environment': bool(credentials.get('subscription_key')),
        'access_token_current': is_current(tokens),
        'refresh_token_present': bool(tokens.get('refresh_token')),
        'network_checked': False,
    }, indent=2))


def safe_error(error):
    if isinstance(error, HTTPError):
        return f'Suunto: HTTP {error.code}. Sprawdź autoryzację, subskrypcję lub limit API.'
    if isinstance(error, URLError):
        return 'Brak połączenia z Suunto (DNS/sieć/TLS). Żadne klucze nie zostały wypisane.'
    if isinstance(error, AccessError):
        return str(error)
    return f'Nie zakończono operacji ({type(error).__name__}); dane autoryzacji nie są wyświetlane.'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configure', action='store_true', help='Jednorazowo wpisz i zapisz oba klucze na niewidocznym wejściu')
    parser.add_argument('--refresh', action='store_true', help='Sprawdź odświeżenie zapisanych tokenów')
    args = parser.parse_args()
    if args.configure:
        configure()
    if args.refresh:
        get_access_token(force=True)
        print('Odświeżenie OAuth zakończone i zapisane lokalnie.')
    status()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nPrzerwano.', file=sys.stderr)
        sys.exit(130)
    except (AccessError, OSError, ValueError, URLError, EOFError) as exc:
        print(safe_error(exc), file=sys.stderr)
        sys.exit(1)
