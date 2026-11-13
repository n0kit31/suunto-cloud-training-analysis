# Changelog

Notable changes to Suunto Cloud Training Analysis are recorded here.

## [Unreleased]

Future iterations are developed on the `develop` branch.

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
- Workout listing currently reads one API page, so complete history is not guaranteed.
- Credentials, OAuth tokens, raw workout files, and personal reports remain outside the release.
- Licensed under GNU GPL v3 or later (`GPL-3.0-or-later`).

[Unreleased]: https://github.com/n0kit31/suunto-cloud-training-analisys/compare/v1.0.0...develop
[1.0.0]: https://github.com/n0kit31/suunto-cloud-training-analisys/tree/v1.0.0
