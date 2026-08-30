import { describe, expect, it } from 'vitest';
import {
  compareByRisk,
  deriveStaleness,
  scoreDependency,
  type RiskSignals,
} from './score.js';

const NOW_SECONDS = 1_800_000_000;
const DAY = 24 * 60 * 60;

const exact = (value: number): RiskSignals['authorCount'] => ({ kind: 'exact', value });
const atLeast = (value: number): RiskSignals['authorCount'] => ({ kind: 'at-least', value });

const baseSignals = (overrides: Partial<RiskSignals> = {}): RiskSignals => ({
  truckFactor: 1,
  topAuthorShare: 0.6,
  authorCount: exact(20),
  unattributedCommits: 0,
  totalCommits: 100,
  archived: false,
  activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 30 * DAY, a: 0, c: 1, d: 0 }] },
  ...overrides,
});

describe('deriveStaleness', () => {
  it('returns unknown for empty week data', () => {
    expect(deriveStaleness([], { nowUnixSeconds: NOW_SECONDS })).toEqual({ kind: 'unknown' });
  });

  it('uses latest week with commits as last activity', () => {
    const result = deriveStaleness(
      [
        { w: NOW_SECONDS - 200 * DAY, a: 0, c: 3, d: 0 },
        { w: NOW_SECONDS - 20 * DAY, a: 0, c: 0, d: 0 },
        { w: NOW_SECONDS - 40 * DAY, a: 0, c: 2, d: 0 },
      ],
      { nowUnixSeconds: NOW_SECONDS },
    );

    expect(result.kind).toBe('known');
    if (result.kind === 'known') {
      expect(result.daysSinceCommit).toBe(40);
      expect(result.lastCommitWeekUnix).toBe(NOW_SECONDS - 40 * DAY);
    }
  });
});

describe('scoreDependency', () => {
  it('treats archived repos as severe regardless of other strengths', () => {
    const archived = scoreDependency(
      baseSignals({
        truckFactor: 1,
        topAuthorShare: 0.95,
        authorCount: exact(4),
        archived: true,
      }),
      { nowUnixSeconds: NOW_SECONDS },
    );

    expect(archived.total).toBeGreaterThan(80);
    expect(archived.factors.some((f) => f.signal === 'archived' && f.points >= 60)).toBe(true);
  });

  it('uses at-least author counts as floor, not exact evidence', () => {
    const exactScore = scoreDependency(
      baseSignals({ authorCount: exact(58), topAuthorShare: 0.6 }),
      { nowUnixSeconds: NOW_SECONDS },
    );
    const floorScore = scoreDependency(
      baseSignals({ authorCount: atLeast(58), topAuthorShare: 0.6 }),
      { nowUnixSeconds: NOW_SECONDS },
    );

    expect(floorScore.total).toBeGreaterThan(exactScore.total);
    expect(
      floorScore.factors.some((f) => f.signal === 'author-count-floor' && f.direction === 'up'),
    ).toBe(true);
  });

  it('penalizes stale projects and reduces fresh ones', () => {
    const stale = scoreDependency(
      baseSignals({
        activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 500 * DAY, a: 0, c: 1, d: 0 }] },
      }),
      { nowUnixSeconds: NOW_SECONDS },
    );
    const fresh = scoreDependency(
      baseSignals({
        activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 10 * DAY, a: 0, c: 2, d: 0 }] },
      }),
      { nowUnixSeconds: NOW_SECONDS },
    );

    expect(stale.total).toBeGreaterThan(fresh.total);
  });
});

describe('compareByRisk', () => {
  const toRow = (name: string, signals: RiskSignals) => ({
    packageName: name,
    score: scoreDependency(signals, { nowUnixSeconds: NOW_SECONDS }),
  });

  it('separates the crowded TF=1 tier and keeps yaml riskier than chalk', () => {
    const rows = [
      toRow(
        'yaml',
        baseSignals({
          truckFactor: 1,
          topAuthorShare: 0.95,
          authorCount: exact(4),
          activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 15 * DAY, a: 0, c: 2, d: 0 }] },
        }),
      ),
      toRow(
        'zod',
        baseSignals({
          truckFactor: 1,
          topAuthorShare: 0.67,
          authorCount: exact(20),
          activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 12 * DAY, a: 0, c: 3, d: 0 }] },
        }),
      ),
      toRow(
        'express',
        baseSignals({
          truckFactor: 1,
          topAuthorShare: 0.66,
          authorCount: exact(40),
          activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 20 * DAY, a: 0, c: 2, d: 0 }] },
        }),
      ),
      toRow(
        'popper.js',
        baseSignals({
          truckFactor: 1,
          topAuthorShare: 0.62,
          authorCount: exact(16),
          redirectedFrom: { owner: 'floating-ui', repo: 'popper.js' },
          activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 180 * DAY, a: 0, c: 1, d: 0 }] },
        }),
      ),
      toRow(
        'chalk',
        baseSignals({
          truckFactor: 1,
          topAuthorShare: 0.6,
          authorCount: exact(58),
          activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 18 * DAY, a: 0, c: 2, d: 0 }] },
        }),
      ),
      toRow(
        'semver',
        baseSignals({
          truckFactor: 2,
          topAuthorShare: 0.47,
          authorCount: exact(30),
          activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 25 * DAY, a: 0, c: 2, d: 0 }] },
        }),
      ),
      toRow(
        'left-pad',
        baseSignals({
          truckFactor: 2,
          topAuthorShare: 0.36,
          authorCount: exact(12),
          archived: true,
          activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 2000 * DAY, a: 0, c: 1, d: 0 }] },
        }),
      ),
      toRow(
        'undici',
        baseSignals({
          truckFactor: 3,
          topAuthorShare: 0.38,
          authorCount: atLeast(100),
          activity: { kind: 'weeks', weeks: [{ w: NOW_SECONDS - 8 * DAY, a: 0, c: 5, d: 0 }] },
        }),
      ),
    ];

    const ranked = [...rows].sort(compareByRisk);
    const names = ranked.map((r) => r.packageName);

    expect(names.indexOf('yaml')).toBeLessThan(names.indexOf('chalk'));
    expect(names[0]).toBe('left-pad');
    expect(names[names.length - 1]).toBe('semver');
  });
});
