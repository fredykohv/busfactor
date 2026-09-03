# Engineering guidelines

Implementation-level reference for agents working in this codebase: where things live, how the
code is shaped, and current CLI/cache mechanics. This is not domain vocabulary - see
[`CONTEXT.md`](../../CONTEXT.md) for the concepts and invariants these implementations must
respect.

## Module map

| Concept | Implementation |
| --- | --- |
| Direct dependency extraction | `readManifest` in `src/scan.ts` |
| npm `repository` field parsing / resolution | `src/resolve-repo.ts`, pure part is `parseRepositoryField` |
| Truck factor and line signal | `src/truck-factor.ts` |
| Risk scoring | `src/score.ts` |
| Registry (npm) signals: publish recency, maintainers | `src/registry-signals.ts` |
| GitHub `403` classification | `src/github-forbidden.ts` (shared by the repo checker and stats client) |
| On-disk response cache | `src/cache.ts` |

## CLI surface and exit codes

Public command is `truckguard` (see [ADR-0002](../adr/0002-rename-npm-package-to-truckguard.md)).
Current invocation: `truckguard scan [path]` with `--dev`, `--json`, `--markdown`,
`--output <path>`, `-h`/`--help`, `-v`/`--version`. `--json` and `--markdown` are mutually
exclusive. Unknown commands and options are rejected, never ignored. Full flag and environment
documentation lives in [README.md](../../README.md); this is a pointer, not a duplicate.

Exit codes (`exitCodeFor`):

| Code | Meaning |
| --- | --- |
| `0` | The scan ran. Some dependencies may be skipped; skips are reported, never hidden. |
| `1` | Bad usage, an unreadable `package.json`, or **every** dependency was skipped. |

## Cache semantics

`src/cache.ts` wraps `fetch` with a persistent on-disk GET cache (`TRUCKGUARD_CACHE_DIR`, default
`~/.cache/truckguard`, 24-hour TTL).

Rules, all deliberate:

- **GET only.** Non-GET requests, and requests with `cache-control: no-store`, bypass the cache
  entirely.
- **Only `200` responses are cached.** Errors, rate limits, and `202` are never persisted - caching
  a rate-limit response would poison a whole day of runs.
- **Empty bodies and `[]` are never cached.** An empty contributor array is GitHub's "still
  computing" signal, not a result. Caching it would freeze a false empty answer for the TTL.
  **Forbidden:** removing this check as a perceived optimisation.
- **Oversized entries are not cached** (default 5 MB cap).
- **Writes are atomic:** temp file then `rename`, so an interrupted process cannot leave a
  half-written entry.
- **Expired or corrupt entries are removed and refetched**, not repaired.

## Code shape rules

1. Keep pure logic pure. `truck-factor.ts`, `score.ts`, `readManifest`, `parseRepositoryField`, and
   the registry parsers do no IO, no clock reads, and no caching; IO lives behind injectable
   adapters so tests never touch the network.
2. Model absence as a variant that carries no numbers, not as an optional number (see
   "Unknown is not zero" in `CONTEXT.md`).
3. Prefer adding a reported state over adding a default value.
4. Use the vocabulary defined in `CONTEXT.md` in identifiers, tests, issues, and output. Do not
   drift to synonyms (`busFactor`, `owners`, `contributors count`).
5. Documentation stays ASCII.

Read [ADR-0001](../adr/0001-commit-based-truck-factor.md) before touching `src/truck-factor.ts`. If
a change contradicts an ADR, say so explicitly instead of overriding it silently.
