# Docker

The image includes Python 3.13, Node.js 24, and FIT decoder dependencies.
The host only needs Docker Desktop or Docker Engine with Compose; Python and
Node.js are not required. The container provides the same CLI commands as
local execution.

Cloud API commands require an approved API application and credentials
supplied by the installation's operator. See
[independence and API access](../README.md#independence-and-api-access) for
Suunto's access requirements and the operator's responsibilities.

## Setup

From the repository directory:

```sh
export SUUNTO_UID="$(id -u)" SUUNTO_GID="$(id -g)"
mkdir -p .local ../reports ../visualizations
cp -n config.example.json config.json
```

Existing configuration is preserved. In a new `config.json`, enter the
application's `client_id` from Suunto API Zone and set `timezone` to your local
IANA time zone name, such as `America/New_York`. Keep the callback at
`http://127.0.0.1:8765/callback`, matching the application settings in API Zone.

Set UID/GID in each new terminal session before running Compose. This lets the
container access the user's private files and save results with the correct
ownership. The image's default UID/GID is `1000:1000`.

## Build and usage

```sh
docker compose build
docker compose run --rm suunto --help
docker compose run --rm suunto sync --date 2026-01-15 --analysis --brief
```

Replace the example date with your activity date; `--date` may be repeated.
Add `--charts` for charts. The image uses the local tag
`suunto-cloud-training-analysis:local`; building does not publish it to a registry.

## Authorization

For local dates in Docker, configure your time zone in `config.json` or export
`SUUNTO_TIMEZONE` or `TZ` before running Compose. The container otherwise uses
its own system zone, normally UTC. See [time zone selection](../README.md#time-zones)
for precedence and examples.

If `credentials.json` and `tokens.json` already exist in `.local/`, the container
uses them and refreshes tokens automatically. Initial sign-in can run entirely
inside the container:

```sh
docker compose run --rm --service-ports suunto oauth
docker compose run --rm suunto access --configure
```

Open the printed link on the computer running Docker and sign in to your Suunto
account. Enter credentials interactively using hidden input. They are saved
locally in `.local/`.

The `--service-ports` option publishes the callback only on the host's
`127.0.0.1:8765`. Inside the container, the server listens on `0.0.0.0` so port
forwarding works; callback address, Host header, and OAuth state checks remain
active. Other commands do not require published ports.

Check status without displaying credentials:

```sh
docker compose run --rm suunto access
```

If the refresh token is rejected, run `oauth` again with `--service-ports`.

## Data and credentials

| Host path | Container path | Access |
| --- | --- | --- |
| `config.json` | `/app/suunto-cloud/config.json` | Read-only |
| `.local/` | `/app/suunto-cloud/.local/` | Read/write |
| `../reports/` | `/app/reports/` | Read/write |
| `../visualizations/` | `/app/visualizations/` | Read/write |

Removing the container with `--rm` preserves host data. Paths stored in manifests
and JSON files refer to container locations; the table maps them to host paths.

The Dockerfile copies only code, dependencies, and the license. `.dockerignore`
excludes local configuration, `.local/`, `.env`, `.npmrc`, credentials, and
workout data from the build context. Compose runs the CLI as a non-root user
with a read-only image filesystem and separate data mounts.

The official Suunto MCP remains an external agent integration. The image handles
direct Cloud API and FIT access; it does not use the host application's MCP
authorization.

## Third-party licenses

The image includes the matching Node.js license and bundled component notices
at `/usr/local/share/doc/node/LICENSE`. FIT decoder dependencies retain their
original license files under `/app/suunto-cloud/node_modules/`. The image also
includes [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) in the application
directory. These components retain their own licenses.

## Project helper

The `../skills/suunto-training-analysis/scripts/run-docker.sh` helper sets UID/GID
and the Compose directory. Its `build` command rebuilds the application image
after code changes. The `charts` command regenerates a chart from an existing
report and FIT samples without downloading data again:

```sh
sh ../skills/suunto-training-analysis/scripts/run-docker.sh build
sh ../skills/suunto-training-analysis/scripts/run-docker.sh charts /app/reports/suunto-2026-01-15-080000.json
```

## Image verification

```sh
sh scripts/docker/test-image.sh
```

The script builds the `test` stage with offline tests, then the application
image, checks the CLI without network access, and verifies that the image
contains third-party license notices and no private configuration or runtime
data. It does not use your credentials or call Suunto API.
