# busfactor

**Ranks your direct npm dependencies by how badly you'd be stuck if the maintainers vanished.**

Existing tools tell you a package has 3 maintainers. They don't tell you that two of them last committed in 2021, and that the third wrote 94% of the code you actually import.

`busfactor` computes that.

```bash
npx busfactor scan
```

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

Pre-alpha. The metric is validated (see [Why commits](#why-commits-and-not-lines)); the CLI is not built yet.

See `docs/agents/` for how this repo is organised.

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
