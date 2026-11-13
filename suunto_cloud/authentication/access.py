#!/usr/bin/env python3
"""Private local Suunto credentials, serialized OAuth refresh and authenticated reads."""

import argparse
import base64
import fcntl
import getpass
import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener

from suunto_cloud.authentication.oauth import NoRedirect, TOKEN_URL
from suunto_cloud.storage.local import config_path, private_directory, private_json
from suunto_cloud.timezones import TimeZoneError


class AccessError(RuntimeError):
    pass


def load_config():
    config = json.loads(config_path().read_text())
    if not isinstance(config, dict) or not isinstance(config.get('client_id'), str) or not config['client_id']:
        raise AccessError('Missing Client ID in config.json.')
    return config


def load_credentials():
    config = load_config()
    path = private_directory() / 'credentials.json'
    credentials = json.loads(path.read_text()) if path.is_file() else {}
    if not isinstance(credentials, dict):
        raise AccessError('Invalid credentials.json format.')
    if credentials and credentials.get('client_id') != config['client_id']:
        raise AccessError('Saved credentials belong to a different Client ID. Run python3 -m suunto_cloud access --configure.')
    for field, variable in [('client_secret', 'SUUNTO_CLIENT_SECRET'),
                             ('subscription_key', 'SUUNTO_SUBSCRIPTION_KEY')]:
        if os.environ.get(variable):
            credentials[field] = os.environ[variable].strip()
        if field in credentials and not isinstance(credentials[field], str):
            raise AccessError('Invalid saved credential format.')
    credentials['client_id'] = config['client_id']
    return credentials


def configure():
    config = load_config()
    path = private_directory() / 'credentials.json'
    if not sys.stdin.isatty():
        raise AccessError('Run configuration in your interactive terminal; do not pass credentials as arguments.')
    print('One-time Suunto setup. Credential input is hidden.')
    print('Get the client secret and Primary/Secondary Key from https://apizone.suunto.com/profile')
    credentials = {'client_id': config['client_id']}
    for field, prompt in [('client_secret', 'Client secret from OAuth application settings: '),
                           ('subscription_key', 'Primary or Secondary Key from the Developer API subscription: ')]:
        value = getpass.getpass(prompt).strip()
        if not value:
            raise AccessError('Both credentials are required; the configuration file was not changed.')
        credentials[field] = value
    private_json(path, credentials)
    print('Credentials saved to .local/credentials.json (0600, directory 0700, excluded from Git).')
    print('This confirms local storage. The sync command checks connectivity and credential validity.')


def load_tokens():
    path = private_directory() / 'tokens.json'
    if not path.is_file():
        raise AccessError('No saved tokens. Run python3 -m suunto_cloud oauth.')
    tokens = json.loads(path.read_text())
    if not isinstance(tokens, dict) or tokens.get('client_id') != load_config()['client_id']:
        raise AccessError('Token and configuration Client IDs differ. Authorize again with python3 -m suunto_cloud oauth.')
    if not isinstance(tokens.get('access_token'), str) or not tokens['access_token']:
        raise AccessError('No valid access token. Authorize with python3 -m suunto_cloud oauth.')
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
        raise AccessError('Missing refresh token. Authorize again with python3 -m suunto_cloud oauth.')
    secret = credentials.get('client_secret')
    if not secret:
        raise AccessError('No saved client secret. Run python3 -m suunto_cloud access --configure.')
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
            raise AccessError('Refresh token rejected. Run python3 -m suunto_cloud oauth to authorize again; do not paste tokens into chat.') from None
        if error == 'invalid_client' or exc.code == 401:
            raise AccessError('OAuth refresh: check the client secret and Client ID; update saved credentials with python3 -m suunto_cloud access --configure.') from None
        raise AccessError(f'OAuth refresh failed: HTTP {exc.code}. Tokens were not changed.') from None
    if not isinstance(result, dict) or not isinstance(result.get('access_token'), str) or not result['access_token']:
        raise AccessError('Invalid refresh response. Tokens were not changed.')
    try:
        expires = int(result.get('expires_in', 0))
    except (ValueError, TypeError):
        expires = 0
    if expires <= 0 or ('refresh_token' in result and
                        (not isinstance(result['refresh_token'], str) or not result['refresh_token'])):
        raise AccessError('Invalid expiry or refresh token. Tokens were not changed.')
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
        raise AccessError('No saved Developer API key. Run python3 -m suunto_cloud access --configure.')
    token = get_access_token()
    try:
        return operation(token, key)
    except HTTPError as exc:
        if exc.code != 401:
            raise
        with exc:
            body = exc.read(4096).decode('utf-8', errors='replace').lower()
        if 'subscription' in body and ('invalid' in body or 'missing' in body):
            raise AccessError('Cloud API rejected the subscription key; check it with python3 -m suunto_cloud access --configure.') from None
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
        return f'Suunto: HTTP {error.code}. Check authorization, subscription, or API rate limits.'
    if isinstance(error, URLError):
        return 'Cannot connect to Suunto (DNS/network/TLS). No credentials were displayed.'
    if isinstance(error, (AccessError, TimeZoneError)):
        return str(error)
    return f'Operation failed ({type(error).__name__}); authentication data is not displayed.'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configure', action='store_true', help='Enter and save both credentials once using hidden input')
    parser.add_argument('--refresh', action='store_true', help='Check refresh of saved tokens')
    args = parser.parse_args(argv)
    if args.configure:
        configure()
    if args.refresh:
        get_access_token(force=True)
        print('OAuth refresh completed and saved locally.')
    status()


def run(argv=None):
    try:
        main(argv)
    except KeyboardInterrupt:
        print('\nInterrupted.', file=sys.stderr)
        return 130
    except (AccessError, OSError, ValueError, URLError, EOFError) as exc:
        print(safe_error(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(run())
