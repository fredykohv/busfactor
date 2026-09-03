# truckguard

**Ranks your direct npm dependencies by how badly you'd be stuck if the maintainers vanished.**

Existing tools tell you a package has 3 maintainers. They don't tell you that two of them last committed in 2021, and that the third wrote 94% of the code you actually import.

`truckguard` computes that.

```bash
npx truckguard scan
```

Risk scores are **heuristics**, not certainties: they combine truck factor, author concentration, liveness, and other signals into a single explainable number, with the reasoning shown alongside it. Treat a high score as "worth a closer look," not as a verdict.

## Installation

Requires **Node.js 20 or later**.

Run it without installing anything:

```bash
npx truckguard scan
```

Or install it globally:

```bash
npm install --global truckguard
truckguard scan
```

Or as a local dev dependency, invoked via `npx` or an `npm` script:

```bash
npm install --save-dev truckguard
npx truckguard scan
```

### First command

```bash
npx truckguard scan
```

Run from a directory containing a `package.json` (or point it at one — see [Usage](#usage)). The first run creates a local cache under `~/.cache/truckguard` (see [Environment](#environment)) and prints a ranked table to stdout.

## Usage

```
truckguard scan [path] [options]
```

`path` is a directory containing a `package.json`, or a path to the `package.json` itself. It defaults to the current directory.

| Option | Effect |
| --- | --- |
| `--dev` | Include `devDependencies` as well as `dependencies`. |
| `--json` | Emit the full result set as JSON, including skipped entries. |
| `--markdown` | Emit an explainable Markdown report. |
| `--output <path>` | Write the Markdown report to a deterministic file path (requires `--markdown`). |
| `-h`, `--help` | Show usage. |
| `-v`, `--version` | Show the version. |

`--json` and `--markdown` are mutually exclusive. Unknown commands and options are rejected rather than ignored, so a typo never quietly produces a different report.

When `--output` is used, Markdown is written to that file and not printed to stdout. This is intended for CI artifact paths.

### Environment

| Variable | Effect |
| --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | Raises the GitHub rate limit from 60 to 5000 requests per hour. Without it, most dependency lists will be partly skipped. |
| `TRUCKGUARD_CACHE_DIR` | Where responses are cached. Defaults to `~/.cache/truckguard`, with a 24-hour TTL. |

```bash
export GITHUB_TOKEN="$(gh auth token)"
npx truckguard scan --dev
```

Progress is written to stderr, so `--json` and `--markdown` output stays pipeable.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The scan ran. Some dependencies may still be reported as skipped — skips are reported, never hidden. |
| `1` | Bad usage, an unreadable `package.json`, or no dependency could be analysed at all. |

Note that a partially skipped scan exits `0` on purpose: a rate limit on three of forty packages is a caveat, not a failure. A scan where *nothing* resolved is a failure, and CI should hear about it.

## Why

Dependency tooling today splits into two camps:

- **Vulnerability scanners** (Snyk, Dependabot, OSV) — tell you about known CVEs. Backward-looking.
- **Supply-chain monitors** (Socket.dev) — detect malicious or compromised updates. Catches active attacks.

Neither answers the question that actually keeps maintainers up at night:

> If the person maintaining this package stopped tomorrow, how screwed am I?

That's not a vulnerability. It's not an attack. It's slow decay, and nobody measures it.

## The metric

### Truck factor

> The **truck factor** of a repository is the smallest number of authors whose combined contribution accounts for at least 50% of the surviving codebase.

A truck factor of 1 means one person wrote the majority of the code. If they leave, the knowledge leaves.

**How we compute it.** True truck factor requires `git blame` over every file, attributing each surviving line to an author. Cloning every dependency to do this is impractical for a CLI.

Instead we use GitHub's `/repos/{owner}/{repo}/stats/contributors` endpoint, which returns per-author commit counts, additions, and deletions, pre-aggregated, in a single request.

**We rank by commits, not lines.** The obvious approach — net lines added, as a proxy for surviving lines — turns out not to work. See [Why commits](#why-commits-and-not-lines) below; this was settled empirically, not by preference.

So: take each author's commit total, sort descending, and count how many authors it takes to cross 50% of all commits.

### Why commits and not lines

We built the line-based version first and measured it against ten packages whose maintenance reality we already knew. It failed in two ways.

**Large repositories return no line data at all.** GitHub stops computing line-level statistics past a certain repository size. `facebook/react` returns 500 contributor entries with `additions: 0` and `deletions: 0` on every one. A line-based truck factor reports **0** for React — not a parse error, just silently wrong. Commit totals are still present and correct for the same repository.

**Line data barely discriminates.** Across the sample, line-based truck factor only ever produced 1 or 2. It rated `axios` identically to `lodash`, which does not match how those projects are actually maintained.

Commit-based truck factor, on the same sample:

| Package | TF (commits) | Top author share | Line data available? |
| --- | --- | --- | --- |
| `yargs` | 7 | 27% | yes |
| `react` | 6 | 10% | **no** |
| `axios` | 2 | 39% | yes |
| `express` | 1 | 66% | yes |
| `chalk` | 1 | 60% | yes |
| `lodash` | 1 | 89% | yes |

Wider range, works where line data doesn't, and the ordering matches reality.

**Commits have their own bias** — a thousand typo fixes outweigh one architectural rewrite. We report net lines as a secondary signal wherever it's available, precisely so this bias is visible rather than hidden. Where line data is missing, we say so rather than pretending to a precision we don't have.

### Two caveats we surface rather than hide

**Contributor truncation.** The endpoint returns at most 100 contributors (500 for very large repositories). This does not affect the truck factor — authors outside the top 100 cannot influence a 50% threshold — but it does mean total author counts are reported as `100+`, never as an exact figure.

**Missing line data is a reported state, not a zero.** When a repository returns no line statistics, that is surfaced explicitly. A dependency is never scored as maximally risky because of a gap in GitHub's data.

### Beyond truck factor

Truck factor alone is misleading. A truck factor of 1 is fine if that one person is actively maintaining, funded, and responsive. It is alarming if they went quiet 18 months ago.

So the score combines:

| Signal | Question it answers | Source |
| --- | --- | --- |
| **Truck factor** | How concentrated is authorship? | GitHub contributor stats (commits) |
| **Author concentration** | What share did the top author commit? | GitHub contributor stats |
| **Line-based concentration** | Does line data agree with commit data? | GitHub contributor stats (when available) |
| **Maintainer liveness** | Are the top authors still committing? | GitHub commits |
| **Release cadence** | Is it still being shipped? | npm registry |
| **Staleness** | How long since the last release? | npm registry |
| **Publisher count** | How many people can publish to npm? | npm registry |
| **Issue backlog** | Is the maintainer underwater? | GitHub issues |
| **Response time** | Do issues and PRs get answered? | GitHub issues |
| **Hard flags** | Archived, deprecated, no repo | both |
| **Downloads** | How much should you care? (weighting, not risk) | npm |

## Scope

**v1 deliberately does not do:**

- **Transitive dependencies.** Direct dependencies only. Transitive is 10–50x the packages, blows the GitHub rate limit, and produces findings you can't act on. Direct deps are the ones you chose and the ones you can replace.
- **Import weighting.** Scoring by how much of your code actually touches a package is the strongest differentiator, and it needs static analysis. It's the planned v2 headline, not a v1 feature.
- **Maintainer correlation graphs.** Finding that twelve of your dependencies share one maintainer is genuinely valuable and genuinely out of scope for a first release.

**And it never does:**

- **Give you a number without the reasoning.** Every score shows the signals that produced it. A risk score you can't audit is a risk score you can't argue with, and it will be wrong sometimes.

## Status

Pre-alpha. The metric is validated (see [Why commits](#why-commits-and-not-lines)), and `truckguard scan` works end to end with table, JSON, and Markdown output.

See `docs/agents/` for how this repo is organised.

## GitHub Actions distribution

This repository ships a practical workflow at `.github/workflows/distribution.yml` that runs `truckguard` against the checked-out repository and publishes a shareable Markdown report.

### What it does

1. Checks out the repository being built.
2. Installs dependencies and builds this CLI from source.
3. Runs `node dist/cli.js scan --markdown --output .github/artifacts/busfactor-report.md`.
4. Publishes that report as an Actions artifact.
5. Appends the same Markdown to the workflow run summary.

### Required permissions and token use

The job requests:

- `contents: read` (checkout)
- `actions: read` (artifact/upload workflow metadata interactions)

Pass `GITHUB_TOKEN` to the scan step. This raises GitHub API limits from 60 to 5000 requests/hour and keeps ordinary repositories from being dominated by rate-limit skips.

The token is never rendered into the report output by this tool.

### Locations

- Deterministic report file in the runner workspace: `.github/artifacts/busfactor-report.md`
- Uploaded artifact name: `busfactor-report`
- Job summary: `$GITHUB_STEP_SUMMARY`

Generated report files are not committed; they are CI artifacts and run summaries.

### Failure behavior

- Invalid CLI usage or an unreadable manifest exits non-zero.
- A scan where no dependency could be analysed exits non-zero.
- Ordinary partial skips (for example, some rate-limited or missing repos) are preserved in the report but still exit zero.

### Limitation

v1 analysis is **direct dependencies only** (`dependencies`, plus `devDependencies` only when `--dev` is passed). Transitive dependency analysis is intentionally out of scope.

## Releasing

Releases are never automatic. `.github/workflows/release.yml` only runs on a manual `workflow_dispatch` or a pushed `v*` tag, and only publishes if an `NPM_TOKEN` secret is configured in the `npm-release` environment. To cut a release:

1. Bump `version` in `package.json` (and `package-lock.json` via `npm install --package-lock-only`).
2. Update `CHANGELOG.md`.
3. Merge to `main`, then push a matching `vX.Y.Z` tag (or run the workflow manually).

The workflow runs typecheck/test/build, verifies the tag matches `package.json`, then runs `npm publish --provenance --access public`. It requires an `NPM_TOKEN` npm automation token to be added as a repository secret (in a `npm-release` environment) before it can succeed. Nobody has done this yet — publishing is a deliberate manual step.

## Prior art

- [OpenSSF Scorecard](https://github.com/ossf/scorecard) — security *practices*: branch protection, CI, signed releases. Repo hygiene, not human sustainability.
- [Socket.dev](https://socket.dev) — behavioural analysis of package code to catch compromised updates. Active compromise, not slow decay.
- [deps.dev](https://deps.dev) — free API exposing dependency graphs and maintainer metadata. Raw signals, no computed risk.
- [Libraries.io SourceRank](https://libraries.io) — popularity and activity heuristics. High-level, largely stale.
- [Snyk Advisor](https://snyk.io/advisor) — package health scores. Sunsetting January 2026, which leaves a gap.
- [Tidelift](https://tidelift.com) — pays maintainers for commitments. Solves the problem rather than measuring it, but only for a curated catalogue.

None of them compute a truck factor.

## Licence

MIT
