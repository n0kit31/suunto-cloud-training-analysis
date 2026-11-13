# Suunto Cloud Training Analysis

A CLI for downloading data from Suunto Cloud API and analyzing FIT files.
Supports OAuth with automatic token refresh, GPX export, and JSON and Markdown
reports with laps, heart rate, pace, pauses, and running mechanics. SVG charts
are optional.

Data from the official Suunto MCP can be added through an external integration.
The current tools download data from Cloud API; this repository has no MCP client.

## Structure

Code in `suunto_cloud/` is organized by responsibility:

| Directory | Responsibility |
| --- | --- |
| `authentication/` | OAuth, credentials, and authenticated requests |
| `downloads/` | Workout summaries and FIT downloads |
| `analysis/` | Metric calculations and analysis packet preparation |
| `reporting/` | Markdown/JSON reports and SVG charts |
| `synchronization/` | Download, analysis, and reporting coordination |
| `storage/` | Configuration paths and secure local storage |
| `fit/` | Node.js FIT decoder and GPX exporter |

Tests in `tests/` follow the same structure. Calculations are independent of API
access and file storage. Commands are handled by `suunto_cloud/cli.py`.

## Requirements

For local execution:

- Python 3.9+ on macOS or Linux, with the `Europe/Warsaw` timezone available.
- Node.js and the `fit-file-parser` package for FIT decoding.
- An OAuth application and Developer API subscription in [Suunto API Zone](https://apizone.suunto.com/how-to-start).

## Setup

Run commands from the repository directory. Install FIT decoder dependencies
and create the local configuration:

```sh
npm ci --ignore-scripts --no-audit --no-fund
cp -n config.example.json config.json
```

Enter your `client_id` and check `redirect_uri` in `config.json`.
The default callback is `http://127.0.0.1:8765/callback`; it must match the
application settings in API Zone. Then authorize your account and configure
credentials:

```sh
python3 -m suunto_cloud oauth
python3 -m suunto_cloud access --configure
```

Enter credentials interactively using hidden input. Local configuration,
tokens, and downloaded data are excluded from Git and the Docker build context.

## Usage

Download and analyze workouts from a selected date:

```sh
python3 -m suunto_cloud sync --date 2026-01-15 --analysis --brief
```

Dates use the `Europe/Warsaw` timezone; `--date` may be repeated.
Add `--charts` to generate a chart. Raw data and analyses are in `.local/`,
reports in `../reports/`, and charts in `../visualizations/`.
Charts use active workout time: pauses are removed from the time axis and have
no separate markers. Missing pace and elevation measurements remain gaps in
the line. Heart rate is smoothed with a centered 15 s moving average of
available samples, calculated separately for continuous measurement segments.
Heart rate gaps are connected linearly on the chart only, producing a
continuous curve. HR statistics come from source data. Reports use decimal
points, and chart filenames end in `-overview.svg`.
The current version downloads one page of the workout list, not the complete
history.

Regenerate an existing chart without downloading data again:

```sh
python3 -m suunto_cloud charts ../reports/suunto-2026-01-15-080000.json
```

Other commands: `workouts`, `track`, `analyze`, and `access`.
Help: `python3 -m suunto_cloud --help` or `python3 -m suunto_cloud sync --help`.
The legacy `python3 sync.py ...` command still works through a compatibility wrapper.

## Docker

The Dockerfile includes the Python/Node.js runtime and FIT decoder dependencies.
Compose mounts configuration and data outside the image. See the
[Docker instructions](docs/docker.md) for directory setup, UID/GID, and authorization.

```sh
docker compose build
docker compose run --rm suunto sync --date 2026-01-15 --analysis --brief
```

## Tests

```sh
python3 -m unittest discover -s tests -t . -v
```

Tests use synthetic data and do not require API access.

## License

Copyright (C) 2026 Marcin Krzyżanowski.

This project is licensed under **GNU GPL v3 or later** (`GPL-3.0-or-later`).
See [LICENSE](LICENSE) for the full text.
