# Changelog

Notable changes to Suunto Cloud Training Analysis are recorded here.

## [Unreleased]

### Added

- Run a local workout library with React, Fastify, SQLite, and Docker Compose.
  A background worker reuses the Python analyzer for offline single-session FIT
  imports and Suunto Cloud workouts. [Web app guide](docs/web.md)
- Import the most recent 30 calendar days on the first successful Suunto sync.
  Later syncs fetch new and changed workouts. Save the latest outcome across
  page reloads, with a completion notification and an error list that supports
  individual and bulk dismissal.
- Filter the library by sport or date, with distinct icon colors by activity
  type and an English or Polish interface. Workout details show metrics, laps,
  interactive charts, and the watch model when its name or supported product ID
  is available in the FIT file.
- Generate optional OpenAI or Claude interpretations on demand using selected
  workout metrics and lap summaries. Save each provider's results separately
  and manage its local API key from the app settings.

### Changed

- Store web app data in a persistent Docker volume. Share the private Suunto
  configuration and OAuth tokens between the CLI and the worker. Save Suunto
  API settings from the app before completing OAuth. [Storage and configuration](docs/web.md)
- Document the web workflow and show the activity list, workout overview, and
  settings with synthetic data. [Web app screenshots](README.md#web-app-screenshots)

### Fixed

- Keep credential updates made while an OAuth sign-in is in progress. Resume a
  rejected first import when authorization is corrected.
- Update the open chart after reanalysis and use the same cadence units in the
  chart and workout summary.
- Report rejected OpenAI keys separately from quota errors. Localize API errors
  in the web client and isolate Compose smoke tests from private auth directories.

## [1.3.0] - 2026-11-20

### Added

- Show nightly maximum SpO₂ alongside HRV in recovery reports and charts. Include the night after the workout when sleep data is available.
- Show average watch temperature and Suunto's recovery estimate in workout summaries, with the estimated end date and time in the workout's time zone.
- Add chart header tiles for watch temperature, weather with wind and humidity, post-workout heart-rate change rated by Suunto, and recovery time.

### Fixed

- Give Cloud FIT, GPX, reports, and charts workout-specific filenames to prevent overwrites when workouts start at the same time. Older timestamp-only reports can still be regenerated in place.
- Mark synchronization complete after reports and the analysis packet are saved. Record publication failures in the sync manifest.

## [1.2.0] - 2026-11-18

### Added

- `workouts --all` pages through the workout list. `workouts --since DATE` lists workouts started on or after a local date.
- `import-fit` analyzes a local single-session FIT file without API credentials and saves a separate report. Optional HTML and SVG charts can be regenerated offline.
- Interactive charts support drag-to-zoom and lap selection across workout panels, with statistics from recorded samples or FIT lap summaries.

### Changed

- Date-based synchronization reads workout pages back to the week containing the earliest requested date. The default `workouts` command still fetches the latest page.

## [1.1.1] - 2026-11-18

Documentation-only release; application behavior is unchanged from 1.1.0.

### Changed

- The README marathon example is a single SVG exported from the HTML chart, showing the workout feeling and all nine panels.
- Repository privacy rules cover self-contained interactive HTML charts in `docs/examples/`.

### Added

- Self-contained interactive HTML version of the marathon example in `docs/examples/marathon-overview.html`.

### Removed

- Separate power/terrain and running-mechanics example SVGs, now part of the combined overview.

## [1.1.0] - 2026-11-16

### Added

- Offline interactive HTML charts with a synchronized cursor, pinned readouts, keyboard time selection, and SVG downloads.
- Workout summaries and same-week comparisons of available sessions, with distance, active time, and HR-based TSS totals.
- Charts for power, cadence, ground contact, estimated step length, speed, and estimated terrain grade.
- Optional sleep and HRV context from private snapshots, with nightly history, sleep stages, and calculated historical reference colors.
- Activity type, recorded start/end times, and a colored workout feeling tile in chart headers.

### Changed

- Filled, smoothed workout charts, expanded non-HR axes, fixed 10-minute time ticks, and a configurable heart rate range (65–190 bpm by default).
- Refreshed README illustrations with expanded marathon charts and a separate synthetic sleep/HRV example.

### Fixed

- Restored Python 3.9 compatibility and refreshed the test-count badge.

## [1.0.0] - 2026-11-13

First stable release of the Docker-ready CLI for downloading and analyzing
Suunto workouts, with local reports and portable charts.

### Added

- Suunto OAuth authorization, automatic token refresh, and private credential storage.
- Fresh Cloud API workout summaries, original FIT downloads, FIT decoding, and GPX export.
- Analysis of laps, pauses, heart rate, pace, power, running mechanics, and SuuntoPlus fields.
- Markdown and JSON reports, plus SVG charts with active workout time and a continuous, smoothed heart rate line.
- Configurable user time zones for calendar dates, local timestamps, filenames, and reports, including daylight saving transitions.
- Docker and Compose runtime, CLI version reporting, and container image checks.
- GitHub Actions CI, a generated test-count badge, English documentation, and an approved marathon example.
- Documentation of project independence, API access requirements, and installation operator responsibilities.
- Third-party license summary and container checks for runtime and FIT decoder license notices.

### Fixed

- Preserve the matching Node.js license and bundled component notices in the Docker image.

### Release notes

- The official Suunto MCP is a separate agent integration; the CLI accesses Cloud API directly.
- In 1.0.0, workout listing read one API page.
- Credentials, OAuth tokens, raw workout files, and personal reports remain outside the release.
- Licensed under GNU GPL v3 or later (`GPL-3.0-or-later`).

[Unreleased]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.3.0...develop
[1.3.0]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/n0kit31/suunto-cloud-training-analysis/tree/v1.0.0
