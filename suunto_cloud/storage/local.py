"""Private paths and atomic writes, independent of authentication."""

import hashlib
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import tempfile

from suunto_cloud.timezones import TimeZoneError, resolve_timezone

ROOT = Path(__file__).resolve().parents[2]


def config_path():
    configured = os.environ.get('SUUNTO_CONFIG_PATH')
    return Path(configured) if configured else ROOT / 'config.json'


def read_config():
    path = config_path()
    config = json.loads(path.read_text()) if path.is_file() else {}
    if not isinstance(config, dict):
        raise ValueError('Invalid Suunto configuration.')
    if config.get('client_id') in (None, '', 'YOUR_SUUNTO_CLIENT_ID'):
        generated = configured_auth_directory() / 'config.json'
        if generated.is_file():
            saved = json.loads(generated.read_text())
            if not isinstance(saved, dict):
                raise ValueError('Invalid private Suunto configuration.')
            config = {**saved, **config, 'client_id': saved.get('client_id')}
            if not config.get('redirect_uri'):
                config['redirect_uri'] = saved.get('redirect_uri')
    return config


def user_timezone():
    name = os.environ.get('SUUNTO_TIMEZONE', '').strip()
    if not name:
        try:
            config = read_config()
        except ValueError as error:
            raise TimeZoneError(str(error)) from None
        name = config.get('timezone')
        if name is not None and not isinstance(name, str):
            raise TimeZoneError('The timezone setting must be an IANA time zone name or null.')
        name = (name or '').strip() or os.environ.get('TZ', '').strip().lstrip(':')
    return resolve_timezone(name)


def configured_private_directory():
    configured = os.environ.get('SUUNTO_PRIVATE_DIR')
    return Path(configured) if configured else ROOT / '.local'


def configured_auth_directory():
    configured = os.environ.get('SUUNTO_AUTH_DIR')
    return Path(configured) if configured else configured_private_directory()


def ensure_private_directory(directory):
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    return directory


def private_directory():
    return ensure_private_directory(configured_private_directory())


def authentication_directory():
    return ensure_private_directory(configured_auth_directory())


@contextmanager
def authentication_lock():
    lock_path = authentication_directory() / 'auth.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield


def cloud_artifact_stem(start, workout_key):
    fingerprint = hashlib.sha256(workout_key.encode('utf-8')).hexdigest()[:32]
    return f'{start:%Y-%m-%d-%H%M%S}-cloud-{fingerprint}'


def private_json(destination, data):
    def write(stream):
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')

    return _private_write(destination, write)


def private_text(destination, data):
    return _private_write(destination, lambda stream: stream.write(data))


def _private_write(destination, write):
    destination = Path(destination)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination.parent.chmod(0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=destination.parent,
                                         encoding='utf-8', delete=False) as stream:
            temporary = Path(stream.name)
            os.fchmod(stream.fileno(), 0o600)
            write(stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination
