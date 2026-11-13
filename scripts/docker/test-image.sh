#!/bin/sh
set -eu

suunto_repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$suunto_repo_dir"

docker build --target test --tag suunto-cloud-training-analysis:test .
docker build --target app --tag suunto-cloud-training-analysis:local .
docker run --rm --network none suunto-cloud-training-analysis:local --help
docker run --rm --network none --entrypoint python3 suunto-cloud-training-analysis:local -c '
import os
from pathlib import Path
from zoneinfo import ZoneInfo

root = Path("/app/suunto-cloud")
assert os.geteuid() != 0, "Image must run as a non-root user"
assert not (root / "config.json").exists(), "Local configuration found in image"
assert not any((root / ".local").iterdir()), "Private runtime data found in image"
assert not (root / ".git").exists(), "Git history found in image"
assert not (root / "tests").exists(), "Test files found in application image"
for name in ("UTC", "America/New_York", "Asia/Tokyo"):
    assert ZoneInfo(name).key == name
print("Image checks passed: non-root user, timezone data, no private configuration or runtime data.")
'
