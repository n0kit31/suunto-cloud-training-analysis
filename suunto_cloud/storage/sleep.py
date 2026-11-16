"""Read a private sleep snapshot exported by the official MCP or Suunto 247 API."""

import json
from pathlib import Path


def read_sleep(path, required=False):
    path = Path(path)
    if not required and not path.exists():
        return None
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict) or not isinstance(payload.get('data'), list):
        raise ValueError('Sleep input requires an object with a data array of Suunto 247 samples.')
    if any(not isinstance(row, dict) for row in payload['data']):
        raise ValueError('Invalid sleep sample structure.')
    return payload
