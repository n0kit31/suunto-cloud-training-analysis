"""Read public Suunto settings and save credentials in the worker's private directory."""

import json

from suunto_cloud.authentication.access import AccessError, authentication_lock, load_saved_credentials
from suunto_cloud.storage.local import config_path, private_directory, private_json


DEFAULT_CALLBACK = 'http://127.0.0.1:8765/callback'
FIELDS = {'clientId', 'clientSecret', 'subscriptionKey'}


class InvalidSettings(ValueError):
    pass


def read_configuration():
    path = config_path()
    config = json.loads(path.read_text()) if path.is_file() else {}
    if not isinstance(config, dict):
        raise ValueError('Invalid Suunto configuration.')
    client = config.get('client_id')
    if client == 'YOUR_SUUNTO_CLIENT_ID':
        client = None
    return config, client if isinstance(client, str) and client.strip() else None


def existing_credentials(client):
    if client:
        try:
            return load_saved_credentials(client)
        except (AccessError, ValueError):
            pass
    return {}


def read_settings():
    config, client = read_configuration()
    credentials = existing_credentials(client)
    return {
        'clientId': client,
        'redirectUri': config.get('redirect_uri') or DEFAULT_CALLBACK,
        'clientSecretSaved': bool(saved_key(credentials, 'client_secret')),
        'subscriptionKeySaved': bool(saved_key(credentials, 'subscription_key')),
    }


def saved_key(credentials, name):
    value = credentials.get(name)
    return value.strip() if isinstance(value, str) else ''


def save_settings(payload):
    if not isinstance(payload, dict) or payload.keys() != FIELDS:
        raise InvalidSettings('Provide the Suunto client ID, secret and subscription key.')
    if any(not isinstance(value, str) or len(value) > 512
           or any(ord(character) < 32 or ord(character) == 127 for character in value)
           for value in payload.values()):
        raise InvalidSettings('Check the format of your Suunto credentials.')
    client = payload['clientId'].strip()
    if not client or ':' in client:
        raise InvalidSettings('Enter the client ID from Suunto API Zone.')

    with authentication_lock():
        config, current_client = read_configuration()
        if current_client and client != current_client:
            raise InvalidSettings('The client ID belongs to the existing Suunto configuration.')
        existing = existing_credentials(current_client)
        secret = payload['clientSecret'].strip() or saved_key(existing, 'client_secret')
        subscription = payload['subscriptionKey'].strip() or saved_key(existing, 'subscription_key')
        if not secret or not subscription:
            raise InvalidSettings('Enter both the client secret and the subscription key.')

        if current_client is None:
            private_json(config_path(), {
                **config, 'client_id': client,
                'redirect_uri': config.get('redirect_uri') or DEFAULT_CALLBACK,
            })
        private_json(private_directory() / 'credentials.json', {
            **existing, 'client_id': client, 'client_secret': secret, 'subscription_key': subscription,
        })
    return read_settings()
