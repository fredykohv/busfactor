/**
 * Truck factor computation over already-fetched GitHub contributor statistics.
 *
 * This module is pure: it performs no network IO, no caching and no clock
 * reads. Callers fetch `/repos/{owner}/{repo}/stats/contributors` and hand the
 * parsed response here.
 *
 * Ranking is by commit count, not by lines. See ADR-0001 — that decision is
 * binding and empirically settled; net lines are reported only as a secondary
 * signal, and only when GitHub actually returned line data.
 */

/** One week bucket as returned by GitHub: additions, commits, deletions. */
export interface ContributorWeek {
  /** Unix timestamp of the start of the week. */
  readonly w: number;
  /** Additions in that week. */
  readonly a: number;
  /** Commits in that week. */
  readonly c: number;
  /** Deletions in that week. */
  readonly d: number;
}

/** One entry of GitHub's contributor-stats response. */
export interface ContributorStat {
  /** `null` when GitHub cannot map the commits to an account. */
  readonly author: { readonly login: string } | null;
  /** Total commits by this contributor. */
  readonly total: number;
  readonly weeks: readonly ContributorWeek[];
}

/**
 * A count that may have been clipped by GitHub's contributor cap (100, or 500
 * for very large repositories). `at-least` means "this many or more"; it is
 * deliberately not interchangeable with `exact`.
 */
export type AuthorCount =
  | { readonly kind: "exact"; readonly value: number }
  | { readonly kind: "at-least"; readonly value: number };

/**
 * The secondary line-based signal.
 *
 * The unavailable branch carries *no numeric fields at all*, so a caller cannot
 * read a missing signal as a zero — they must narrow on `available` first, and
 * the compiler enforces it. This is the type-level guard demanded by ADR-0001:
 * a dependency must never look maximally concentrated because of a gap in
 * GitHub's data.
 */
export type LineSignal =
  | {
      readonly available: true;
      /** Truck factor computed over net lines (additions - deletions). */
      readonly truckFactor: number;
      /** Total net lines across all attributable authors with positive net. */
      readonly netLines: number;
      /** Share of net lines written by the largest line contributor, 0..1. */
      readonly topAuthorShare: number;
    }
  | { readonly available: false; readonly reason: "no-line-data" };

export interface TruckFactorReport {
  readonly kind: "ok";
  /** Smallest number of authors whose commits cover >= 50% of the total. */
  readonly truckFactor: number;
  readonly topAuthor: {
    readonly login: string;
    /** Share of attributable commits, 0..1. */
    readonly share: number;
  };
  /** Attributable commits only; excludes commits with a null author. */
  readonly totalCommits: number;
  /** Commits GitHub could not map to an account. */
  readonly unattributedCommits: number;
  readonly authorCount: AuthorCount;
  readonly lines: LineSignal;
}

export type TruckFactorUnavailable = {
  readonly kind: "unavailable";
  readonly reason: "no-authors" | "no-commits";
};

export type TruckFactorResult = TruckFactorReport | TruckFactorUnavailable;

/**
 * GitHub truncates the contributor list at 100 entries, or 500 for very large
 * repositories. Hitting either exactly means the list may have been clipped.
 */
const TRUNCATION_CAPS = [100, 500] as const;

const sum = (values: readonly number[]): number =>
  values.reduce((acc, n) => acc + n, 0);

/**
 * Smallest prefix of a descending-sorted list whose sum reaches half of
 * `total`. Never returns 0 for a non-empty, positive-total list.
 */
const minimalCoveringPrefix = (
  descending: readonly number[],
  total: number,
): number => {
  const threshold = total / 2;
  let running = 0;
  for (const [index, value] of descending.entries()) {
    running += value;
    if (running >= threshold) return index + 1;
  }
  return descending.length;
};

const netLinesOf = (stat: ContributorStat): number =>
  sum(stat.weeks.map((week) => week.a - week.d));

const computeLineSignal = (
  attributable: readonly ContributorStat[],
): LineSignal => {
  // Authors who removed more than they added carry no surviving-line weight,
  // and including negatives would let one deleter shrink the denominator.
  const nets = attributable
    .map(netLinesOf)
    .filter((net) => net > 0)
    .sort((a, b) => b - a);

  const netLines = sum(nets);
  const top = nets[0];
  if (netLines <= 0 || top === undefined) {
    return { available: false, reason: "no-line-data" };
  }

  return {
    available: true,
    truckFactor: minimalCoveringPrefix(nets, netLines),
    netLines,
    topAuthorShare: top / netLines,
  };
};

const authorCountOf = (returnedEntries: number, authors: number): AuthorCount =>
  (TRUNCATION_CAPS as readonly number[]).includes(returnedEntries)
    ? { kind: "at-least", value: authors }
    : { kind: "exact", value: authors };

/**
 * Computes the truck factor for one repository from its contributor stats.
 *
 * Contributors with a `null` author are excluded from both the ranking and the
 * commit denominator — an unmapped entry is not a person a project could lose,
 * and leaving it in the denominator would understate concentration among the
 * people who do exist. Their commits are still reported, as
 * `unattributedCommits`, so nothing is silently discarded.
 *
 * Returns an `unavailable` result rather than a zero when the input carries no
 * usable signal.
 */
export const computeTruckFactor = (
  stats: readonly ContributorStat[],
): TruckFactorResult => {
  const attributable = stats.filter(
    (stat): stat is ContributorStat & { author: { login: string } } =>
      stat.author !== null,
  );
  if (attributable.length === 0) {
    return { kind: "unavailable", reason: "no-authors" };
  }

  const unattributedCommits = sum(
    stats.filter((stat) => stat.author === null).map((stat) => stat.total),
  );

  const ranked = [...attributable].sort((a, b) => b.total - a.total);
  const totals = ranked.map((stat) => stat.total);
  const totalCommits = sum(totals);
  const top = ranked[0];
  if (totalCommits <= 0 || top === undefined) {
    return { kind: "unavailable", reason: "no-commits" };
  }

  return {
    kind: "ok",
    truckFactor: minimalCoveringPrefix(totals, totalCommits),
    topAuthor: { login: top.author.login, share: top.total / totalCommits },
    totalCommits,
    unattributedCommits,
    authorCount: authorCountOf(stats.length, attributable.length),
    lines: computeLineSignal(attributable),
  };
};
