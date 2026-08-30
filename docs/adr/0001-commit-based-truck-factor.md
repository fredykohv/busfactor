# ADR-0001: Compute truck factor from commit counts, not line counts

**Status:** Accepted
**Date:** 2026-08-30

## Context

The truck factor of a repository is the smallest number of authors whose combined contribution covers at least 50% of the codebase. The canonical definition is line-based: `git blame` every file, attribute each surviving line, then find the minimal author set.

Cloning every dependency to run `git blame` is impractical for a CLI that should finish in seconds. GitHub's `/repos/{owner}/{repo}/stats/contributors` endpoint offers a cheaper path: one request per repository, returning per-author commit totals plus weekly additions and deletions.

The obvious mapping is to use net lines (additions minus deletions) as a proxy for surviving lines, staying close to the canonical definition. We implemented that first and measured it against ten npm packages whose maintenance reality we already knew.

## Decision

**Rank authors by commit count, not by net lines.**

Net lines are retained as a secondary, reported signal wherever the data exists, but they do not determine the truck factor.

## Rationale

Two empirical findings, both from the M0 spike.

**1. Line data is absent on large repositories.**

`facebook/react` returns 500 contributor entries in which every single `additions` and `deletions` value is zero. GitHub stops computing line-level statistics past some repository size. This is not a parse error and not a rate limit; commit totals for the same repository are present and correct.

A line-based truck factor reports `0` for React. Silently, and with no indication that the input was empty rather than the project being maximally concentrated. Any tool that produces "React has a truck factor of 0" is not credible.

**2. Line data barely discriminates.**

Across the sample, line-based truck factor produced only the values 1 and 2. It rated `axios` identically to `lodash`. That does not match how those projects are maintained, and a metric that cannot separate them cannot rank a dependency tree.

Commit-based truck factor on the same sample:

| Repository | TF (commits) | Top author share | Line data present |
| --- | --- | --- | --- |
| `yargs/yargs` | 7 | 27% | yes |
| `facebook/react` | 6 | 10% | **no** |
| `axios/axios` | 2 | 39% | yes |
| `expressjs/express` | 1 | 66% | yes |
| `chalk/chalk` | 1 | 60% | yes |
| `lodash/lodash` | 1 | 89% | yes |

Wider range, works where line data does not exist, and the ordering matches the projects' known maintenance shape.

## Consequences

**We inherit a different bias.** Commit counts treat a thousand typo fixes as more contribution than one architectural rewrite. Line counts have the opposite bias. Neither is neutral. We chose the one that is always available and empirically more discriminating, and we report net lines alongside the score so the disagreement is visible to the reader rather than hidden inside it.

**Missing line data becomes a first-class state.** The absence of line statistics must be represented and surfaced, never coerced to zero. A dependency must never be scored as risky because of a gap in GitHub's data.

**Contributor truncation is acknowledged, not corrected.** The endpoint returns at most 100 contributors, or 500 for very large repositories. This does not affect the truck factor, since authors outside the top 100 cannot influence a 50% threshold. It does mean total author counts are approximate and must be reported as `100+` rather than as an exact figure.

**This decision is reversible if we ever clone.** Should a future version fetch repositories locally, a true blame-based truck factor becomes available and would supersede this. That is not a v1 concern.

## Alternatives considered

**Net lines with a fallback to commits when line data is empty.** Rejected. The fallback would have applied to exactly the repositories where the metric matters most, and the two signals are not on comparable scales, so a dependency list would silently mix two different metrics in one ranking.

**Cloning each dependency and running `git blame`.** The correct metric, and unshippable: minutes per dependency and gigabytes of disk for a tool expected to run in CI.

**deps.dev or Libraries.io contributor data.** Neither exposes per-author contribution volume, only maintainer counts, which is the exact shallow signal this project exists to improve on.
