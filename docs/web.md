# Local workout library

The web app is designed for a single user on the computer running Docker.
Fastify serves the React interface. A separate worker uses the existing
Python analyzer and writes completed results to SQLite.

## Start

Set the container user to your local UID and GID and start the services.

```sh
export SUUNTO_UID="$(id -u)" SUUNTO_GID="$(id -g)"
mkdir -p "${SUUNTO_WEB_AUTH_DIR:-.}/.local"
docker compose up -d --build web worker
```

Open `http://127.0.0.1:3000`. Set `SUUNTO_WEB_PORT` before starting if you
need a different local port. FIT upload and playback of stored charts work
without a Suunto connection. The importer accepts one-session FIT files.
The interface defaults to English. Select **PL** in the header for Polish.
For local time in both the library and plots, set `SUUNTO_TIMEZONE` to an
IANA zone such as `Europe/Warsaw` before starting. The default is UTC.

## Connect Suunto

An approved Suunto API application and valid Developer API subscription are
needed for cloud synchronization. Open **App settings → Suunto** in the app's
header and save the client ID, client secret, and subscription key from
[Suunto API Zone](https://apizone.suunto.com/profile). The app shows whether a
secret or key has been saved and leaves that value in place if you submit its
field empty. Register the callback `http://127.0.0.1:8765/callback` with Suunto
when configuring a new installation.

Authorize your Suunto account once from the project directory. Use the same
UID, GID, and auth directory settings you used to start the worker.

```sh
docker compose run --rm --no-deps -p 127.0.0.1:8765:8765 \
  -e SUUNTO_OAUTH_BIND_HOST=0.0.0.0 --entrypoint python3 worker -m suunto_cloud oauth
```

Follow the displayed authorization link in your browser. The worker starts the
initial 30-day import once authorization is available. An initial import that
stopped on an authorization error resumes after you update the credentials or
sign in again. Use **Fetch new activities** for subsequent syncs. The button
shows progress and a notification reports completion. Expand **Last sync
result** in the activity list to see the outcome again after reloading.

Click the **Errors** counter to see the failed job, its message, and the linked
activity where available. Remove individual errors or clear the list. The
workout overview shows the recording model when the FIT file provides a name
or a recognized product identifier.

## Storage and performance

- The `web-data` Docker volume holds the SQLite database, the job queue, input
  FIT files and generated charts. Compose stores this volume outside the
  checkout and mounts it into the web and worker containers at runtime.
- The CLI and web worker share the checkout's `config.json` and `.local/` by
  default. Compose mounts the configuration source read-only. New application
  settings saved by the GUI are read from `.local/config.json` when the root
  configuration has no client ID. OAuth tokens and credentials live in the
  shared writable `.local/` directory. The web server has neither auth mount.
- Set `SUUNTO_WEB_AUTH_DIR` to an existing private directory with the same
  layout to use it for both services. If a previous installation used the
  `web-auth` Docker volume, configure the selected shared location before
  switching. The activity library is stored in the separate `web-data` volume.
- `docker compose stop` or `docker compose down` preserves Docker volumes.
  `docker compose down -v` deletes the project's volumes and stored workouts.
- The list uses indexed, paginated SQLite queries. Details and charts use
  precomputed results, and import tasks run in the worker. SQLite also stores
  the durable queue. A shared cache like Redis would be worth evaluating if
  profiling a larger deployment shows database reads are a bottleneck.

## Optional AI interpretation

Open **App settings** and choose **OpenAI** or **Claude**. Paste a key for the
selected provider and click **Save**. Scope a Claude key to one workspace when
you create it. [OpenAI API keys](https://platform.openai.com/api-keys),
[Claude API keys](https://platform.claude.com/settings/keys).

The worker stores each key in its private auth directory with mode `0600`.
The interface shows whether a key is saved and lets you remove it from the app.

For file-based OpenAI configuration, mount an existing private key file outside
the checkout with the Compose override. That file takes precedence over the key
saved in the UI.

```sh
export SUUNTO_WEB_OPENAI_KEY_PATH="$HOME/.config/suunto-web/openai-api-key"
docker compose -f compose.yaml -f compose.ai.yaml up -d --build
```

In a completed workout, click **Interpret activity** under the provider you
want to use. The worker sends selected numeric measurements and laps to that
provider and saves each result separately. AI interpretation runs on demand.
FIT imports and Suunto synchronization perform the local metrics analysis.
FIT files, GPS, account details, and authorization data stay local.
