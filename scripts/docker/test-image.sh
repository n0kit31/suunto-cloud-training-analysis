#!/bin/sh
set -eu

suunto_repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$suunto_repo_dir"

docker build --target test --tag suunto-cloud-training-analysis:test .
docker build --target app --tag suunto-cloud-training-analysis:local .
docker run --rm --network none suunto-cloud-training-analysis:local --help
docker run --rm --network none suunto-cloud-training-analysis:local --version
suunto_image_version=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' suunto-cloud-training-analysis:local)
docker run --rm --network none --entrypoint python3 \
    --env "SUUNTO_IMAGE_VERSION=$suunto_image_version" suunto-cloud-training-analysis:local -c '
import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo

from suunto_cloud import __version__

root = Path("/app/suunto-cloud")
assert __version__ == os.environ["SUUNTO_IMAGE_VERSION"], "Image version label does not match the application"
assert json.loads((root / "package.json").read_text())["version"] == __version__, "Package version mismatch"
assert os.geteuid() != 0, "Image must run as a non-root user"
assert not (root / "config.json").exists(), "Local configuration found in image"
assert not any((root / ".local").iterdir()), "Private runtime data found in image"
assert not (root / ".git").exists(), "Git history found in image"
assert not (root / "tests").exists(), "Test files found in application image"
for name in ("UTC", "America/New_York", "Asia/Tokyo"):
    assert ZoneInfo(name).key == name
print("Image checks passed: matching release versions, non-root user, timezone data, no private configuration or runtime data.")
'
