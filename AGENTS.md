# Repository and private data

- The private GitHub repository covers this directory (`suunto-cloud`).
- Use `marcin@it-krzyzanowski.pl` for commits in this repository, configured
  locally with Git (`user.email`); preserve global Git settings.
- Never add to Git or upload real keys, secrets, access tokens, refresh tokens,
  or authorization headers. This also applies to documentation, examples,
  tests, logs, and Docker images.
- Use only unambiguous placeholders or synthetic data in examples, except for
  the explicitly approved documentation example below.
  `config.example.json` is a template; the actual `config.json` and all of
  `.local/` remain local and are ignored by Git.
- Preserve existing configuration and tokens. Do not replace them with placeholders.
- FIT files, GPX files, reports, and personal `TRAINING*.md` context stay outside
  the repository.
- The user explicitly approved their marathon analysis as a README example.
  That example may include aggregate metrics and chart-only SVGs in
  `docs/examples/`. Omit account/workout identifiers, GPS coordinates,
  credentials, raw FIT/GPX files, and full report JSON.
- Before committing or pushing, check the staged files for secrets. Do not print
  any discovered values in the terminal or response.
- `.gitignore` and `.dockerignore` must exclude private data. Do not bypass these
  rules with `git add -f` or by copying secrets elsewhere in the repository.

# Code structure

- Application code is in `suunto_cloud/`, organized by responsibility;
  tests in `tests/` follow the same structure.
- Calculations in `analysis/fit.py`, `analysis/metrics.py`, and
  `analysis/packet.py` remain independent of network access, credentials,
  and file storage.
- Always run the application through Docker Compose for workout analyses.
  The local skill uses `scripts/run-docker.sh` from its own directory.
  Host Python remains available for development and tests; the root `sync.py`
  provides compatibility with legacy commands.
- Configuration and `.local/` remain in the repository directory; do not move
  them along with modules or create copies of credentials.

# Docker

- The Dockerfile copies only code, dependency metadata, and the license;
  configuration and `.local/` are mounted at runtime and stay out of the image.
- Compose runs the CLI as the host user identified by `SUUNTO_UID` and
  `SUUNTO_GID`; set them with `id -u` and `id -g` before working with existing files.
- The container's OAuth callback may listen on `0.0.0.0` only when its port is
  published on the host loopback. Execution outside the container defaults to loopback.
- The `test` Dockerfile stage runs offline tests; the final `app` stage contains
  no test directory. Do not claim a successful build without verifying it.
