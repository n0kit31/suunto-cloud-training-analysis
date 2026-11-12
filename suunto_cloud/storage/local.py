"""Private configuration paths and atomic JSON writes, independent of authentication."""

import json
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def config_path():
    return ROOT / 'config.json'


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
