# CONTEXT

Domain vocabulary and invariants for `busfactor`. Read this before changing code.

`busfactor` ranks a project's **direct npm dependencies** by how badly the project
would be stuck if the maintainers vanished. The public npm package and CLI command
are `truckguard` (see [ADR-0002](docs/adr/0002-rename-npm-package-to-truckguard.md));
the repository, issue tracker, and domain vocabulary in this document remain
`busfactor`. For user-facing usage (flags, env vars, examples), see
[README.md](README.md). For where concepts live in code, see
[docs/agents/engineering-guidelines.md](docs/agents/engineering-guidelines.md). This
file is for contributors and AI coding agents: it fixes the language, and states the
rules that must not be broken.

Related reading: [`docs/adr/`](docs/adr/) for decisions, [`docs/agents/`](docs/agents/)
for how the repo is operated.

---

## 1. Bus factor and truck factor

- **Bus factor** - the informal, popular name for the risk being measured: how
  many people have to disappear before a project is in trouble. It is the
  product name and the framing used in prose. It is not a computed value.
- **Truck factor** - the computed metric. The smallest number of authors whose
  combined contribution covers at least 50% of a repository's contribution
  total. This is the term used for the value itself, wherever it appears.

Use "truck factor" whenever naming the computed value. Do not treat "bus factor"
and "truck factor" as synonyms; the two words are not interchangeable in this
project.

### Commit-based truck factor (binding)

The canonical academic definition of truck factor is line-based: attribute every
surviving line in a repository to an author. This project **does not** do that.

> The truck factor here is computed from **per-author commit counts**: sort
> authors by commit total descending, and count how many are needed to reach 50%
> of the attributable commit total.

This was settled empirically in [ADR-0001](docs/adr/0001-commit-based-truck-factor.md)
and is binding.

**Forbidden:** never replace, "improve", or silently fall back to a line-based
truck factor. Two measured reasons: large repositories (e.g. `facebook/react`)
return zero line data, which yields a truck factor of `0` that is silently wrong;
and line-based values barely discriminate (only ever 1 or 2 across the validation
sample, rating `axios` the same as `lodash`).

Commit counting has its own bias - a thousand typo fixes outweigh one
architectural rewrite. That bias is accepted and made visible by reporting lines
as a secondary signal, not corrected by switching metrics.

### Line signal (secondary, may be absent)

The **line signal** is a secondary net-lines measure (additions minus deletions,
positive contributors only). It never determines the truck factor. It exists so a
reader can see when line data disagrees with commit data.

Its absence is a distinct, explicit state - not a numeric zero and not an optional
value defaulted away. A missing line signal must never be read or reported as "no
line contribution."

---

## 2. Dependencies, resolution, and scope

- **Direct dependency** - a name declared in the manifest's `dependencies`, plus
  `devDependencies` when dev-dependency scanning is requested.
- **Transitive dependency** - out of scope for v1. Not fetched, not scored, not
  mentioned in output as if it were analysed. See "Boundaries of v1" below.
- **Resolution** - mapping an npm package name to a GitHub repository location
  (owner, repo, optional monorepo directory) via the registry's `repository`
  field.
- **Canonical repository** - the slug GitHub currently serves. When a repo has
  been renamed or transferred, GitHub redirects; the canonical slug and what
  npm metadata originally claimed are both retained.
- **Moved repository** - a resolution where the canonical slug differs from
  what npm metadata claimed. It is a small risk signal (stale links), not a
  failure.
- **Analysed dependency** - resolution and contributor stats both succeeded and
  a truck factor was computed.
- **Skipped dependency** - carries a machine-readable reason, a printable
  detail, and a remedy when the user can act.

### Output completeness guarantee (invariant)

> Every name in the manifest comes back in the results array, either analysed or
> skipped with a stated reason.

**Forbidden:** never filter, drop, or quietly swallow a skipped dependency in a
scan, a report, or any output mode. A report that lists only successes creates
false confidence by omission. Every output mode must account for skips.

---

## 3. Contributor statistics

- **Contributor stat** - one author's aggregated commit total and weekly
  addition/deletion buckets, as reported by GitHub for a repository.
- **Attributable commits** - commits whose author is identifiable. Only these
  are ranked, and only these form the truck factor denominator: an unmapped
  commit is not a person a project can lose.
- **Unattributed commits** - the summed total of commits with no identifiable
  author. Excluded from the ranking, but still reported and scored as a small
  confidence penalty. Nothing is discarded silently.
- **Author count** - either **exact** or **at-least**. GitHub truncates the
  contributor list at a fixed cap (100 entries, 500 for very large
  repositories); hitting the cap exactly means the list may have been clipped,
  so the count is reported as at-least (rendered as `100+`). Truncation cannot
  affect the truck factor, because authors outside the cap cannot influence a
  50% threshold.

**Forbidden:** never present an at-least count as exact, and never coerce the
two kinds into a single number for scoring convenience. They are separate
signals on purpose.

### Unknown is not zero (invariant)

Truck factor, line signal, publish recency, and maintainer count all have an
explicit "unavailable"/"unknown" state distinct from zero, used whenever the
input carries no usable signal.

> A dependency must never be scored as risky, or as safe, because of a gap in
> upstream data.

**Forbidden:** defaulting an unknown signal to `0`, to a neutral midpoint, or to
a guess. Unknown signals are omitted from the score and stated in the output.

---

## 4. Registry signals

Registry (npm) signals answer a different question from commit history: commits
say who *writes* the code, npm ownership says who can *release* it.

- **Publish recency / last publish** - the timestamp of the version currently
  tagged `latest`. Unknown when there is no latest version or no timestamp; the
  unknown state carries no age, so it cannot be misread as "published today".
- **Staleness** - two distinct kinds, do not conflate them. Repository
  staleness is days since the last commit activity. Publish staleness is days
  since the last npm release.
- **Maintainer / publisher count** - npm accounts that can publish the package.
  Absent and empty are both treated as unknown: a published package always has
  at least one owner, so an empty list is a metadata artefact, and reporting
  "0 maintainers" would claim more than the truth.

Maintainer count and truck factor can be the same person counted twice (the
motivating case is `yaml`: truck factor 1, one npm maintainer, same account).
They are reported as distinct signals so the scoring model can decide, rather
than burying the correlation upstream.

---

## 5. Risk score and explainability

A risk score is a total clamped to `0..100`, plus the factors that produced it.

- **Risk factor contribution** - one signal's effect on the total: which
  signal, how many points, which direction, and a one-sentence reason.
- **Direction** - up raises risk (concentration, staleness, archived,
  unattributed commits, moved repo). Down lowers it (recent activity, fresh
  release, breadth of authors, multiple npm maintainers). Points are always a
  positive magnitude; the sign lives in direction, not in a negative point
  value.
- **Ranking** - deterministic: total descending, then summed upward points,
  then package name.

### Explainability (invariant)

> Every score ships the signals that produced it.

**Forbidden:** emitting a total without its factors, hiding factors behind a
verbosity flag, or adding a signal that cannot be stated in one human sentence.
A risk score you cannot audit is a risk score you cannot argue with.

The weighting model is an explicit judgement call, not a validated statistical
model. It may be tuned; it may not become opaque.

---

## 6. GitHub failure vocabulary

GitHub overloads `403`, and the correct advice differs completely per case. Both
the repo checker and the stats client classify failures the same way so the two
cannot drift apart.

| Term | Meaning | Remedy surfaced |
| --- | --- | --- |
| **SAML-protected** | Body mentions SAML enforcement: the token lacks organisation access. | Authorise the token for that organisation, then re-run. |
| **Rate-limited** | Primary rate limit exhausted, or a body mentioning a secondary rate limit. | Wait for reset / set a GitHub token; for secondary limits, reduce concurrency. |
| **Request failed** | Any other 403, non-recognised status, or transport error. | None; detail only. |
| **Not found** | 404: deleted, renamed without redirect, or private to us. | None; the dependency needs replacing. |
| **Blocked** | 451, legal takedown. | None. |
| **Still computing** | GitHub had not finished aggregating stats within the retry budget. | Re-run shortly. |

**Forbidden:** collapsing these into a single "unavailable" reason. The whole
point of the taxonomy is that the user's next action differs.

**Still computing** deserves care: contributor stats compute asynchronously. A
cold repository can return an empty-body response, or - an undocumented but
consistent behaviour - a successful response with an empty array. Both mean
"retry". After the retry budget is exhausted, an empty result is reported as
still-computing rather than as an empty repository, because that is
overwhelmingly the common case and the advice is harmless either way.

---

## 7. Boundaries of v1

**v1 deliberately does not do:**

- **Transitive dependencies.** Direct dependencies only. Transitive is 10-50x
  the packages, blows the GitHub rate limit, and produces findings the user
  can't act on.
- **Import weighting.** Scoring by how much of a project's code actually
  touches a dependency needs static analysis and is planned for v2, not v1.
- **Maintainer correlation graphs.** Finding that several dependencies share
  one maintainer is genuinely valuable and genuinely out of scope for a first
  release.

**And it never does:**

- **Give a number without the reasoning.** Every score shows the signals that
  produced it (see "Explainability" above).

---

## 8. Rules of thumb for agents

1. Read [ADR-0001](docs/adr/0001-commit-based-truck-factor.md) before changing
   how truck factor is computed. If a change contradicts an ADR, say so
   explicitly instead of overriding it silently.
2. Use the vocabulary above in identifiers, tests, issues, and output. Do not
   drift to synonyms (`busFactor`, `owners`, `contributors count`).
3. Model absence as a state that carries no numbers, not as an optional number
   defaulted to zero.
4. Prefer adding a reported state over adding a default value.
5. Documentation stays ASCII.
6. For where these concepts live in code (module map, CLI surface, cache
   mechanics), see
   [docs/agents/engineering-guidelines.md](docs/agents/engineering-guidelines.md).
