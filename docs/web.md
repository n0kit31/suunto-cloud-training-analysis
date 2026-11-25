# Local workout library

The web app is designed for a single user on the computer running Docker.
Fastify serves the React interface. A separate worker uses the existing
Python analyzer and writes completed results to SQLite.

## Start

Set the container user to your local UID and GID and start the services.

```sh
export SUUNTO_UID="$(id -u)" SUUNTO_GID="$(id -g)"
docker compose up -d --build
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
initial 30-day import once authorization is available. Use **Fetch new
activities** for subsequent syncs. The button shows when the worker is fetching
or analyzing data, and a notification reports the final outcome. The existing
`access --configure` terminal setup is
also available.

Click the **Errors** counter to see the failed job, its message, and the linked
activity where available. Remove individual errors or clear the list. The
workout overview shows the recording model when the FIT file identifies it.

## Storage and performance

- The `web-data` Docker volume holds the SQLite database, the job queue, input
  FIT files and generated charts. Compose stores this volume outside the
  checkout and mounts it into the web and worker containers at runtime.
- The worker gets its own writable auth mount for the Suunto configuration
  and token files. By default this is the `web-auth` Docker volume. The
  `SUUNTO_WEB_AUTH_DIR` setting selects your private directory instead.
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
