# CONTEXT

Domain vocabulary and invariants for `busfactor`. Read this before changing code.

`busfactor` ranks a project's **direct npm dependencies** by how badly the project
would be stuck if the maintainers vanished. For user-facing usage (flags, env
vars, examples), see [README.md](README.md). This file is for contributors and AI
coding agents: it fixes the language, and states the rules that must not be
broken.

Related reading: [`docs/adr/`](docs/adr/) for decisions, [`docs/agents/`](docs/agents/)
for how the repo is operated.

---

## 1. Bus factor and truck factor

- **Bus factor** - the informal, popular name for the risk being measured: how
  many people have to disappear before a project is in trouble. It is the
  product name and the framing used in prose. It is not a computed field.
- **Truck factor** - the computed metric. The smallest number of authors whose
  combined contribution covers at least 50% of a repository's contribution
  total. This is the term used in code, types, and output (`truckFactor`).

Use "truck factor" whenever naming a value. Do not introduce `busFactor` as an
identifier; the two words are not synonyms in this codebase.

### Commit-based truck factor (binding)

The canonical academic definition of truck factor is line-based: `git blame`
every file and attribute surviving lines. This project **does not** do that.

> The truck factor here is computed from **per-author commit counts** returned by
> GitHub's `/repos/{owner}/{repo}/stats/contributors` endpoint: sort authors by
> commit total descending, and count how many are needed to reach 50% of the
> attributable commit total.

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

`LineSignal` in `src/truck-factor.ts` is the **secondary** net-lines signal
(additions minus deletions, positive contributors only). It never determines the
truck factor. It exists so a reader can see when line data disagrees with commit
data.

It is modelled as a discriminated union whose `available: false` branch carries
**no numeric fields at all**, so the compiler prevents reading a missing signal
as zero. Do not flatten this into optional numbers or a `0` default.

---

## 2. Dependencies, resolution, and scope

- **Direct dependency** - a name in the manifest's `dependencies`, plus
  `devDependencies` when `--dev` is passed. `readManifest` in `src/scan.ts`
  produces this set, deduplicated and sorted.
- **Transitive dependency** - out of scope for v1. Not fetched, not scored, not
  mentioned in output as if it were analysed. See "Scope" in the README.
- **Resolution** - mapping an npm package name to a GitHub `RepoLocation`
  (`owner`, `repo`, optional monorepo `directory`) via the registry's
  `repository` field. `src/resolve-repo.ts` owns this; `parseRepositoryField` is
  the pure part and holds everything learned about real-world `repository`
  shapes.
- **Canonical repository** - the slug GitHub currently serves. When a repo has
  been renamed or transferred, GitHub redirects; `location` holds the canonical
  slug and `redirectedFrom` holds what npm metadata claimed.
- **Moved repository** - a resolution where `redirectedFrom` is set. It is a
  small risk signal (stale links), not a failure.
- **Analysed dependency** (`AnalysedDependency`, `ok: true`) - resolution and
  contributor stats both succeeded and a truck factor was computed.
- **Skipped dependency** (`SkippedDependency`, `ok: false`) - carries a
  machine-readable `reason`, a printable `detail`, and a `remedy` when the user
  can act.

### Output completeness guarantee (invariant)

> Every name in the manifest comes back in the results array, either analysed or
> skipped with a stated reason.

**Forbidden:** never filter, drop, or quietly swallow a skipped dependency in a
scan, a report, or JSON output. A report that lists only successes creates false
confidence by omission. Table, `--json`, and `--markdown` all account for skips.

---

## 3. Contributor statistics

- **Contributor stat** - one entry of GitHub's contributor-stats response:
  `author`, `total` commits, and weekly `{ w, a, c, d }` buckets.
- **Attributable commits** - commits whose entry has a non-null `author`. Only
  these are ranked, and only these form the truck factor denominator: an unmapped
  entry is not a person a project can lose.
- **Unattributed commits** - the summed `total` of entries with a `null` author.
  Excluded from the ranking, but still reported as `unattributedCommits` and
  scored as a small confidence penalty. Nothing is discarded silently.
- **Author count** - `AuthorCount`, either `{ kind: "exact" }` or
  `{ kind: "at-least" }`. GitHub truncates the contributor list at 100 entries
  (500 for very large repositories); hitting either cap exactly means the list may
  have been clipped, so the count is reported as at-least, rendered as `100+`.
  Truncation cannot affect the truck factor, because authors outside the top 100
  cannot influence a 50% threshold.

**Forbidden:** never present an `at-least` count as exact, and never coerce the
two kinds into a single number for scoring convenience. `src/score.ts` scores
them as separate signals (`author-count` vs `author-count-floor`) on purpose.

### Unavailable is not zero (invariant)

`computeTruckFactor` returns `{ kind: "unavailable", reason }` rather than a
zero when the input carries no usable signal (`no-authors`, `no-commits`).
Likewise `LineSignal.available: false`, `LastPublishSignal.known: false`, and
`MaintainerSignal.known: false`.

> A dependency must never be scored as risky, or as safe, because of a gap in
> upstream data.

**Forbidden:** defaulting an unknown signal to `0`, to a neutral midpoint, or to
a guess. Unknown signals are omitted from the score and stated in the output.

---

## 4. Registry signals

`src/registry-signals.ts` reads npm metadata. These answer a different question
from commit history: commits say who *writes* the code, npm ownership says who can
*release* it.

- **Publish recency / last publish** - the timestamp of the version behind the
  `latest` dist-tag. Unknown when there is no latest version or no timestamp;
  the unknown branch carries no `ageDays`, so it cannot be misread as "published
  today".
- **Staleness** - two distinct kinds, do not conflate them. Repository staleness
  is days since the last week bucket containing commits (`deriveStaleness`).
  Publish staleness is days since the last npm release (`publish-recency`).
- **Maintainer / publisher count** - npm accounts that can publish the package.
  Absent and empty are both `known: false`: a published package always has at
  least one owner, so an empty array is a metadata artefact, and reporting
  "0 maintainers" would claim more than the truth.

Maintainer count and truck factor can be the same person counted twice (the
motivating case is `yaml`: truck factor 1, one npm maintainer, same account).
They are reported as distinct signals so the scoring model can decide, rather
than burying the correlation in the parser.

---

## 5. Risk score and explainability

`src/score.ts` produces a `RiskScore`: a `total` clamped to `0..100`, plus the
`factors` that produced it.

- **Risk factor contribution** - `{ signal, points, direction, reason }`.
- **Direction** - `'up'` raises risk (concentration, staleness, archived,
  unattributed commits, moved repo). `'down'` lowers it (recent activity, fresh
  release, breadth of authors, multiple npm maintainers). `points` is always a
  positive magnitude; the sign lives in `direction`. Do not encode direction as a
  negative `points` value.
- **Ranking** - `compareByRisk`: total descending, then summed upward points,
  then package name. Deterministic by construction.

### Explainability (invariant)

> Every score ships the signals that produced it.

**Forbidden:** emitting a total without its factors, hiding factors behind a
verbosity flag, or adding a signal that cannot be stated in one human sentence in
`reason`. A risk score you cannot audit is a risk score you cannot argue with.

The weighting model is an explicit judgement call, not a validated statistical
model. It may be tuned; it may not become opaque.

---

## 6. GitHub failure vocabulary

GitHub overloads `403`, and the correct advice differs completely per case.
`src/github-forbidden.ts` is the single shared classifier; both the repo checker
and the stats client use it so the two cannot drift apart.

| Term | Meaning | Remedy surfaced |
| --- | --- | --- |
| **SAML-protected** (`saml-protected`, `repository-saml-protected`) | Body mentions SAML enforcement: the token lacks organisation access. | Authorise the token for that organisation, then re-run. |
| **Rate-limited** (`rate-limited`, `repository-rate-limited`) | `x-ratelimit-remaining: 0` (primary), or a body mentioning a secondary rate limit. | Wait for reset / set `GITHUB_TOKEN`; for secondary limits, reduce concurrency. |
| **Request failed** (`request-failed`) | Any other 403, non-recognised status, or transport error. | None; detail only. |
| **Not found** (`not-found`, `repository-not-found`) | 404: deleted, renamed without redirect, or private to us. | None; the dependency needs replacing. |
| **Blocked** (`blocked`) | 451, legal takedown. | None. |
| **Still computing** (`still-computing`) | GitHub had not finished aggregating stats within the retry budget. | Re-run shortly. |

**Forbidden:** collapsing these into a single "unavailable" reason. The whole
point of the taxonomy is that the user's next action differs.

**Still computing** deserves care: `/stats/contributors` computes
asynchronously. A cold repository returns `202` with an empty body, and - an
undocumented but consistent behaviour - also returns `200` with `[]`. Both mean
"retry". After the retry budget is exhausted, an empty array is reported as
`still-computing` rather than as an empty repository, because that is
overwhelmingly the common case and the advice is harmless either way.

---

## 7. Cache semantics

`src/cache.ts` wraps `fetch` with a persistent on-disk GET cache
(`BUSFACTOR_CACHE_DIR`, default `~/.cache/busfactor`, 24-hour TTL).

Rules, all deliberate:

- **GET only.** Non-GET requests, and requests with `cache-control: no-store`,
  bypass the cache entirely.
- **Only `200` responses are cached.** Errors, rate limits, and `202` are never
  persisted - caching a rate-limit response would poison a whole day of runs.
- **Empty bodies and `[]` are never cached.** An empty contributor array is
  GitHub's "still computing" signal, not a result. Caching it would freeze a
  false empty answer for the TTL. **Forbidden:** removing this check as a
  perceived optimisation.
- **Oversized entries are not cached** (default 5 MB cap).
- **Writes are atomic:** temp file then `rename`, so an interrupted process
  cannot leave a half-written entry.
- **Expired or corrupt entries are removed and refetched**, not repaired.

---

## 8. CLI surface and exit codes

Current commands and modes (see README for full detail): `busfactor scan [path]`
with `--dev`, `--json`, `--markdown`, `-h`/`--help`, `-v`/`--version`. `--json`
and `--markdown` are mutually exclusive. Unknown commands and options are
**rejected**, never ignored, so a typo cannot quietly produce a different report.

Output modes:

- **table** (default) - human summary on stdout.
- **`--json`** - the full result set, analysed and skipped alike.
- **`--markdown`** - explainable report: ranked table, a "why these scores"
  section listing factors, and a skipped-dependencies section.

Progress and warnings go to **stderr**, so `--json` and `--markdown` stay
pipeable.

Exit codes (`exitCodeFor`):

| Code | Meaning |
| --- | --- |
| `0` | The scan ran. Some dependencies may be skipped; skips are reported, never hidden. |
| `1` | Bad usage, an unreadable `package.json`, or **every** dependency was skipped. |

A partially skipped scan exits `0` on purpose: a rate limit on three of forty
packages is a caveat, not a failure. A scan where nothing resolved is a failure,
and CI should hear about it. **Forbidden:** making partial skips non-zero, or
making a total failure exit `0`.

---

## 9. Rules of thumb for agents

1. Read [ADR-0001](docs/adr/0001-commit-based-truck-factor.md) before touching
   `src/truck-factor.ts`. If a change contradicts an ADR, say so explicitly
   instead of overriding it silently.
2. Use the vocabulary above in identifiers, tests, issues, and output. Do not
   drift to synonyms (`busFactor`, `owners`, `contributors count`).
3. Keep pure logic pure. `truck-factor.ts`, `score.ts`, `readManifest`,
   `parseRepositoryField`, and the registry parsers do no IO, no clock reads, and
   no caching; IO lives behind injectable adapters so tests never touch the
   network.
4. Model absence as a variant that carries no numbers, not as an optional number.
5. Prefer adding a reported state over adding a default value.
6. Documentation stays ASCII.
