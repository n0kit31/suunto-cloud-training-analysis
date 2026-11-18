# Changelog

Notable changes to Suunto Cloud Training Analysis are recorded here.

## [Unreleased]

Future iterations are developed on the `develop` branch.

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

[Unreleased]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.2.0...develop
[1.2.0]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/n0kit31/suunto-cloud-training-analysis/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/n0kit31/suunto-cloud-training-analysis/tree/v1.0.0
