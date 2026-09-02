import type { AuthorCount, ContributorWeek } from './truck-factor.js';

export type RiskActivity =
  | { readonly kind: 'weeks'; readonly weeks: readonly ContributorWeek[] }
  | { readonly kind: 'staleness'; readonly summary: StalenessSummary }
  | { readonly kind: 'unknown' };

export interface RiskSignals {
  readonly truckFactor: number;
  readonly topAuthorShare: number;
  readonly authorCount: AuthorCount;
  readonly unattributedCommits: number;
  readonly totalCommits: number;
  readonly archived: boolean;
  readonly redirectedFrom?: { readonly owner: string; readonly repo: string };
  readonly activity: RiskActivity;
  readonly lastPublish?: { readonly kind: 'known'; readonly unixSeconds: number };
  readonly maintainers?: { readonly kind: 'known'; readonly count: number };
}

export type StalenessSummary =
  | {
      readonly kind: 'known';
      readonly lastCommitWeekUnix: number;
      readonly daysSinceCommit: number;
    }
  | { readonly kind: 'unknown' };

export interface RiskFactorContribution {
  readonly signal:
    | 'archived'
    | 'truck-factor'
    | 'top-author-share'
    | 'author-count'
    | 'author-count-floor'
    | 'staleness'
    | 'publish-recency'
    | 'maintainer-count'
    | 'redirected-repo'
    | 'unattributed-commits';
  readonly points: number;
  readonly direction: 'up' | 'down';
  readonly reason: string;
}

export interface RiskScore {
  readonly total: number;
  readonly factors: readonly RiskFactorContribution[];
  readonly staleness: StalenessSummary;
}

export interface ScoreOptions {
  readonly nowUnixSeconds: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const deriveStaleness = (
  weeks: readonly ContributorWeek[],
  options: ScoreOptions,
): StalenessSummary => {
  const withCommits = weeks.filter((week) => week.c > 0);
  const latest = withCommits.reduce<number | undefined>(
    (acc, week) => (acc === undefined || week.w > acc ? week.w : acc),
    undefined,
  );
  if (latest === undefined) return { kind: 'unknown' };

  const daysSinceCommit = clamp(
    Math.floor((options.nowUnixSeconds - latest) / (24 * 60 * 60)),
    0,
    Number.MAX_SAFE_INTEGER,
  );
  return { kind: 'known', lastCommitWeekUnix: latest, daysSinceCommit };
};

const normalizeStaleness = (
  activity: RiskActivity,
  options: ScoreOptions,
): StalenessSummary => {
  if (activity.kind === 'weeks') return deriveStaleness(activity.weeks, options);
  if (activity.kind === 'staleness') return activity.summary;
  return { kind: 'unknown' };
};

/**
 * Judgement-call weighting model for M2.
 * We intentionally keep few legible signals and return each contribution so M3
 * can render explanation without reverse-engineering arithmetic.
 */
export const scoreDependency = (signals: RiskSignals, options: ScoreOptions): RiskScore => {
  const factors: RiskFactorContribution[] = [];
  const add = (factor: RiskFactorContribution): void => {
    factors.push({ ...factor, points: round2(factor.points) });
  };

  if (signals.archived) {
    add({
      signal: 'archived',
      points: 65,
      direction: 'up',
      reason: 'Repository is archived and effectively unmaintained.',
    });
  }

  const tfPoints = clamp(26 - (signals.truckFactor - 1) * 11, 0, 26);
  if (tfPoints > 0) {
    add({
      signal: 'truck-factor',
      points: tfPoints,
      direction: 'up',
      reason: `Truck factor ${signals.truckFactor} concentrates ownership.`,
    });
  }

  const topSharePoints = clamp((signals.topAuthorShare - 0.45) / 0.55, 0, 1) * 28;
  if (topSharePoints > 0) {
    add({
      signal: 'top-author-share',
      points: topSharePoints,
      direction: 'up',
      reason: `Top author has ${Math.round(signals.topAuthorShare * 100)}% commit share.`,
    });
  }

  const staleness = normalizeStaleness(signals.activity, options);
  if (staleness.kind === 'known') {
    const stalePoints = clamp((staleness.daysSinceCommit - 90) / 275, 0, 1) * 20;
    if (stalePoints > 0) {
      add({
        signal: 'staleness',
        points: stalePoints,
        direction: 'up',
        reason: `No contributor commit activity for ${staleness.daysSinceCommit} days.`,
      });
    } else {
      const freshnessCredit = clamp((90 - staleness.daysSinceCommit) / 90, 0, 1) * 8;
      if (freshnessCredit > 0) {
        add({
          signal: 'staleness',
          points: freshnessCredit,
          direction: 'down',
          reason: `Recent contributor activity (${staleness.daysSinceCommit} days ago).`,
        });
      }
    }
  }

  if (signals.lastPublish !== undefined) {
    const publishAgeDays = Math.max(
      0,
      Math.floor((options.nowUnixSeconds - signals.lastPublish.unixSeconds) / (24 * 60 * 60)),
    );
    const publishStalePoints = clamp((publishAgeDays - 180) / 550, 0, 1) * 14;
    if (publishStalePoints > 0) {
      add({
        signal: 'publish-recency',
        points: publishStalePoints,
        direction: 'up',
        reason: `Latest npm release was ${publishAgeDays} days ago.`,
      });
    } else {
      const publishFreshnessCredit = clamp((180 - publishAgeDays) / 180, 0, 1) * 4;
      if (publishFreshnessCredit > 0) {
        add({
          signal: 'publish-recency',
          points: publishFreshnessCredit,
          direction: 'down',
          reason: `Latest npm release was ${publishAgeDays} days ago.`,
        });
      }
    }
  }

  if (signals.maintainers !== undefined) {
    const maintainerCredit = clamp((signals.maintainers.count - 1) / 9, 0, 1) * 10;
    if (maintainerCredit > 0) {
      add({
        signal: 'maintainer-count',
        points: maintainerCredit,
        direction: 'down',
        reason: `${signals.maintainers.count} npm maintainers lower release concentration risk.`,
      });
    }
  }

  if (signals.authorCount.kind === 'exact') {
    const countCredit = clamp((signals.authorCount.value - 8) / 52, 0, 1) * 18;
    if (countCredit > 0) {
      add({
        signal: 'author-count',
        points: countCredit,
        direction: 'down',
        reason: `${signals.authorCount.value} attributable authors lower single-person risk.`,
      });
    }
  } else {
    const floorCredit = clamp((signals.authorCount.value - 8) / 52, 0, 1) * 18;
    if (floorCredit > 0) {
      add({
        signal: 'author-count-floor',
        points: floorCredit,
        direction: 'down',
        reason: `At least ${signals.authorCount.value} authors observed (GitHub list may be truncated); this is minimum contributor breadth.`,
      });
    }
  }

  const unattributedShare =
    signals.totalCommits > 0
      ? signals.unattributedCommits / (signals.unattributedCommits + signals.totalCommits)
      : 0;
  const unattributedPenalty = clamp((unattributedShare - 0.2) / 0.6, 0, 1) * 6;
  if (unattributedPenalty > 0) {
    add({
      signal: 'unattributed-commits',
      points: unattributedPenalty,
      direction: 'up',
      reason: `${Math.round(unattributedShare * 100)}% commits are unattributed in GitHub stats.`,
    });
  }

  if (signals.redirectedFrom !== undefined) {
    add({
      signal: 'redirected-repo',
      points: 2,
      direction: 'up',
      reason: 'Repository moved; small uncertainty until links stabilize.',
    });
  }

  const raw = factors.reduce((sum, factor) => {
    const signed = factor.direction === 'up' ? factor.points : -factor.points;
    return sum + signed;
  }, 0);

  return {
    total: round2(clamp(raw, 0, 100)),
    factors,
    staleness,
  };
};

export interface ScoredDependency<TMeta = unknown> {
  readonly packageName: string;
  readonly score: RiskScore;
  readonly meta?: TMeta;
}

export const compareByRisk = <TMeta>(
  a: ScoredDependency<TMeta>,
  b: ScoredDependency<TMeta>,
): number =>
  b.score.total - a.score.total ||
  b.score.factors.filter((f) => f.direction === 'up').reduce((s, f) => s + f.points, 0) -
    a.score.factors.filter((f) => f.direction === 'up').reduce((s, f) => s + f.points, 0) ||
  a.packageName.localeCompare(b.packageName);
