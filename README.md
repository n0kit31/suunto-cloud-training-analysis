# Suunto Cloud Training Analysis

[![CI](https://github.com/n0kit31/suunto-cloud-training-analysis/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/n0kit31/suunto-cloud-training-analysis/actions/workflows/ci.yml)
[![Test count](docs/badges/tests.svg)](docs/cli.md#tests)
[![Release: 1.3.0](https://img.shields.io/badge/release-1.3.0-blue)](CHANGELOG.md)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
[![Python: 3.9+](https://img.shields.io/badge/Python-3.9%2B-3776AB?logo=python&logoColor=white)](docs/cli.md#requirements)
[![Node.js: 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](Dockerfile)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](docs/docker.md)

Analyze Suunto workouts locally with a web app and CLI. Import single-session
FIT files, explore routes on a map with synchronized charts, and sync Suunto
Cloud activities with approved API access.

## Local web app

From the checkout, run the following commands with Docker Compose installed.

```sh
export SUUNTO_UID="$(id -u)" SUUNTO_GID="$(id -g)"
mkdir -p "${SUUNTO_WEB_AUTH_DIR:-.}/.local"
docker compose up -d --build web worker
```

Open `http://127.0.0.1:3000`.

- **Import FIT** works offline. Filter the library by sport or date and open
  activities to see metrics, laps, charts, and the watch model when available.
- **GPS routes** appear above the charts. Move the chart cursor to see the
  corresponding point on the route. The OpenStreetMap basemap uses an internet
  connection and the route is drawn from the local FIT.
- **Suunto sync** imports the most recent 30 calendar days on the first
  successful sync. Later syncs fetch new and changed workouts. Use **Last sync
  result** and **Errors** to check the outcome.
- **OpenAI and Claude** provide optional interpretations on request. Each
  provider receives selected metrics and lap summaries when you choose it.
- **English and Polish** are available from the language menu.

The activity library is stored in a local Docker volume. The web worker and CLI
share private Suunto authorization. [Setup, storage, and AI settings](docs/web.md)

### Web app screenshots

The screenshots use synthetic FIT workouts and routes. Map data ©
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

![Activity list with color-coded sport icons and filters](docs/screenshots/activity-list.png)

![Trail running workout with the GPS route and start and finish markers](docs/screenshots/workout-overview.png)

| Chart cursor on the route | App settings |
| --- | --- |
| ![Blue route position synchronized with the heart-rate chart](docs/screenshots/workout-route-cursor.png) | ![Suunto, OpenAI, and Claude settings](docs/screenshots/app-settings.png) |

## CLI and documentation

The CLI supports FIT analysis, GPX export, Markdown and JSON reports, and
portable HTML and SVG charts.

- [Docker setup, OAuth, and FIT import](docs/docker.md)
- [CLI commands, time zones, and recovery metrics](docs/cli.md#usage)
- [Marathon example and synthetic charts](docs/cli.md#example-analysis-marathon)
- [Tests and contributing](docs/cli.md#tests)
- [Changelog](CHANGELOG.md)

## Independence and API access

This project is independent of Suunto Oy. Cloud sync requires an approved OAuth
application and API subscription. API access is subject to Suunto's terms and
eligibility requirements for companies and organizations. Suunto is a trademark
of Suunto Oy. [Suunto API Zone FAQ](https://apizone.suunto.com/faq)

## License

Copyright (C) 2026 Marcin Krzyżanowski.

[GPL-3.0-or-later](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
