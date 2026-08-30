/**
 * Orchestrates a scan: manifest -> resolved repositories -> contributor stats
 * -> truck factor, producing one analysed entry per direct dependency.
 *
 * The one rule this module exists to enforce: **a dependency never silently
 * disappears**. Every name in the manifest comes back either analysed or with
 * a stated reason it could not be, so a report can honestly account for all of
 * them.
 */

import { resolveRepo, type ResolveRepoDeps, type RepoLocation } from './resolve-repo.js';
import type { StatsClient } from './stats-client.js';
import { computeTruckFactor, type TruckFactorReport } from './truck-factor.js';

export interface AnalysedDependency {
  readonly ok: true;
  readonly packageName: string;
  readonly location: RepoLocation;
  readonly report: TruckFactorReport;
  /** Archived upstream: a hard risk flag regardless of the truck factor. */
  readonly archived: boolean;
  /** Set when npm's metadata pointed at a repository that has since moved. */
  readonly redirectedFrom?: RepoLocation;
}

export interface SkippedDependency {
  readonly ok: false;
  readonly packageName: string;
  /** Machine-readable: the resolution or stats failure reason. */
  readonly reason: string;
  /** Human-readable explanation, safe to print. */
  readonly detail: string;
  /** What the user could do about it, when anything. */
  readonly remedy?: string;
}

export type DependencyResult = AnalysedDependency | SkippedDependency;

export interface ScanDeps extends ResolveRepoDeps {
  readonly stats: StatsClient;
  /** Concurrent requests in flight. Default 5, to stay clear of rate limits. */
  readonly concurrency?: number;
}

/** Dependency names read from a manifest. */
export interface Manifest {
  readonly dependencies: readonly string[];
}

/**
 * Extracts direct dependency names from parsed `package.json` contents.
 *
 * Pure, so it is testable without touching a filesystem. `devDependencies` are
 * opt-in: a dev-only package failing is an inconvenience, while a runtime
 * dependency failing ships to users, and mixing them buries the latter.
 */
export const readManifest = (
  packageJson: unknown,
  { includeDev = false }: { includeDev?: boolean } = {},
): Manifest => {
  const source = (packageJson ?? {}) as Record<string, unknown>;
  const collect = (field: string): string[] => {
    const value = source[field];
    return value && typeof value === 'object' ? Object.keys(value) : [];
  };

  const names = new Set(collect('dependencies'));
  if (includeDev) for (const name of collect('devDependencies')) names.add(name);

  return { dependencies: [...names].sort() };
};

/** Runs `worker` over `items`, at most `limit` at a time, preserving order. */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  });

  await Promise.all(runners);
  return results;
};

const analyseOne = async (
  packageName: string,
  deps: ScanDeps,
): Promise<DependencyResult> => {
  const resolution = await resolveRepo(packageName, deps);
  if (!resolution.ok) {
    return {
      ok: false,
      packageName,
      reason: resolution.reason,
      detail: resolution.detail,
    };
  }

  const stats = await deps.stats.fetchContributorStats(resolution.location);
  if (!stats.ok) {
    return {
      ok: false,
      packageName,
      reason: stats.reason,
      detail: stats.detail,
      ...(stats.remedy === undefined ? {} : { remedy: stats.remedy }),
    };
  }

  const report = computeTruckFactor(stats.stats);
  if (report.kind !== 'ok') {
    return {
      ok: false,
      packageName,
      reason: report.reason,
      detail: `contributor statistics carried no usable signal (${report.reason})`,
    };
  }

  return {
    ok: true,
    packageName,
    location: resolution.location,
    report,
    archived: resolution.archived,
    ...(resolution.redirectedFrom === undefined
      ? {}
      : { redirectedFrom: resolution.redirectedFrom }),
  };
};

export const scanDependencies = async (
  manifest: Manifest,
  deps: ScanDeps,
): Promise<DependencyResult[]> =>
  mapWithConcurrency(manifest.dependencies, deps.concurrency ?? 5, (name) =>
    analyseOne(name, deps),
  );
