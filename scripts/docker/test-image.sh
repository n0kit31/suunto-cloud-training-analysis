#!/bin/sh
set -eu

suunto_repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$suunto_repo_dir"

docker build --target test --tag suunto-cloud-training-analysis:test .
docker build --target app --tag suunto-cloud-training-analysis:local .
docker run --rm --network none suunto-cloud-training-analysis:local --help
docker run --rm --network none suunto-cloud-training-analysis:local --version
suunto_image_version=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' suunto-cloud-training-analysis:local)
docker run --rm --network none --entrypoint sh suunto-cloud-training-analysis:local \
    -ec '! command -v python3 && ! command -v python && test -z "$(find /app -type f -name "*.py")"'
docker run --rm --network none --entrypoint node \
    --env "SUUNTO_IMAGE_VERSION=$suunto_image_version" suunto-cloud-training-analysis:local --input-type=module -e '
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "/app/suunto-cloud";
const license = readFileSync("/usr/local/share/doc/node/LICENSE", "utf8");
assert.match(license, /Copyright Node\.js contributors/);
assert.match(license, /permission notice shall be included/);
assert(statSync(join(root, "THIRD_PARTY_NOTICES.md")).isFile());
for (const name of ["fit-file-parser", "buffer", "base64-js", "ieee754"]) {
  const directory = join(root, "node_modules", name);
  assert(readdirSync(directory).some(path => path.startsWith("LICENSE") && statSync(join(directory, path)).size > 0));
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
assert.equal(manifest.version, process.env.SUUNTO_IMAGE_VERSION);
assert.equal(lock.packages[""].version, manifest.version);
assert.equal(lock.version, manifest.version);
assert.notEqual(process.getuid(), 0);
assert.deepEqual(readdirSync(join(root, ".local")), []);
for (const name of ["config.json", ".git", "tests"]) assert(!existsSync(join(root, name)));
for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
  assert.equal(new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone, zone);
}
console.log("Image checks passed: Node-only runtime, licenses, release metadata, timezone data and private-data isolation.");
'
