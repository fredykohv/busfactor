# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - Unreleased

First public release.

### Added

- `busfactor scan` CLI: ranks direct npm dependencies (and, with `--dev`, devDependencies) by commit-based truck factor, author concentration, maintainer liveness, release cadence, staleness, publisher count, issue backlog, response time, and hard flags (archived/deprecated/no repo).
- Output modes: human-readable table (default), `--json` (full result set including skipped entries), and `--markdown` (explainable report), with `--output <path>` to write the Markdown report to a file.
- `--dev` to include devDependencies in the scan.
- `GITHUB_TOKEN` / `GH_TOKEN` support to raise the GitHub API rate limit from 60 to 5000 requests/hour.
- On-disk response cache (`BUSFACTOR_CACHE_DIR`, defaults to `~/.cache/busfactor`, 24-hour TTL).
- Exit code `0` for scans that complete (including partially skipped ones) and `1` for bad usage, an unreadable manifest, or a scan where nothing could be analysed.
- GitHub Actions workflow (`.github/workflows/distribution.yml`) that runs the CLI against a repository and publishes a Markdown report as both a job summary and an artifact.
- 154 tests covering argument parsing, scoring, truck factor computation, GitHub/npm client behaviour, caching, and report rendering.

### Scope

- Direct dependencies only; transitive dependency analysis is intentionally out of scope for this release.
- Risk scores are heuristics. Every score is shown with the signals that produced it.
