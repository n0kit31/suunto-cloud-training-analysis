"""Run the local FIT decoder and locate the Node.js FIT tools."""

import json
from pathlib import Path
import subprocess

SCRIPTS_DIRECTORY = Path(__file__).resolve().parent


def decode_fit(source, destination):
    result = subprocess.run(['node', str(SCRIPTS_DIRECTORY / 'decode.cjs'),
                             str(source), str(destination)], check=False, capture_output=True)
    if result.returncode:
        raise ValueError('FIT decoding failed. Check the input file and the FIT decoder dependencies.')
    return json.loads(destination.read_text())
