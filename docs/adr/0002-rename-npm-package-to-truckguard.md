# ADR-0002: Publish the npm package as `truckguard`, not `busfactor`

**Status:** Accepted
**Date:** 2026-09-03

## Context

The first publish attempt (v0.1.0) was rejected by the npm registry: `busfactor` was judged too
similar to an existing published package, `bus-factor`. npm's similarity check blocks names it
considers confusable with an existing one, and `busfactor` vs `bus-factor` differs only by a
hyphen.

The repository, its domain vocabulary (bus factor, truck factor), and its GitHub identity
(`fredykohv/busfactor`) are unaffected by this — npm's naming rules are a registry-specific
constraint, not a reason to rename the project itself.

## Decision

**Publish the CLI to npm under the unscoped name `truckguard`.** The `bin` command becomes
`truckguard`, and all public installation and invocation examples (README, `--help` text, error
messages) use `truckguard`.

Everything else stays as `busfactor`:

- The GitHub repository remains `fredykohv/busfactor`.
- Domain terms — bus factor, truck factor, `src/truck-factor.ts`, `truckFactor` fields — are
  unchanged; see [CONTEXT.md](../../CONTEXT.md).
- The CI distribution artifact name and report filename remain `busfactor-report` /
  `busfactor-report.md` — these are internal CI conventions for this repository's own workflow,
  not the published package name.
- `docs/agents/`, issue tracker conventions, and the repository's own `.github/artifacts/` paths
  are unaffected.

The first successful publish under the new name starts at `0.1.1`, not `0.1.0` — the `0.1.0` tag
was never actually published (npm rejected it before package creation), and reusing the same
version number as a previously attempted-but-failed release risks confusion.

## Rationale

- Renaming only the public npm package name is the smallest change that unblocks publishing.
  Renaming the repository or the domain vocabulary would be a much larger, unjustified change in
  response to a registry-specific naming collision.
- `truckguard` is short, unscoped, and evokes the tool's purpose (guarding against dependency risk)
  without colliding with `bus-factor`.
- Keeping internal terminology (`busfactor-report`, `truckFactor`, etc.) stable avoids a second,
  unrelated wave of churn across code, tests, and CI that read from this repository's own
  conventions rather than from the public package identity.

## Consequences

- Anyone who ran `npx busfactor scan` against the failed v0.1.0 attempt must switch to
  `npx truckguard scan`. Since v0.1.0 never actually published, no real users are affected.
- `package.json#name` and `bin.truckguard` diverge from the GitHub repository name. This is normal
  for npm packages and is called out explicitly in the README and `AGENTS.md` so it isn't
  mistaken for an inconsistency.
