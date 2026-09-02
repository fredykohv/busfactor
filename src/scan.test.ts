import { describe, expect, it } from 'vitest';
import { readManifest, scanDependencies, type ScanDeps } from './scan.js';
import type { RepoLocation } from './resolve-repo.js';

describe('readManifest', () => {
  it('reads direct dependencies, sorted', () => {
    expect(readManifest({ dependencies: { zod: '^3', chalk: '^5' } })).toEqual({
      dependencies: ['chalk', 'zod'],
    });
  });

  it('excludes devDependencies by default', () => {
    const manifest = readManifest({
      dependencies: { chalk: '^5' },
      devDependencies: { vitest: '^2' },
    });

    expect(manifest.dependencies).toEqual(['chalk']);
  });

  it('includes devDependencies on request, without duplicating overlaps', () => {
    const manifest = readManifest(
      { dependencies: { chalk: '^5' }, devDependencies: { chalk: '^5', vitest: '^2' } },
      { includeDev: true },
    );

    expect(manifest.dependencies).toEqual(['chalk', 'vitest']);
  });

  it.each([
    ['no dependency fields', {}],
    ['null', null],
    ['a non-object dependencies field', { dependencies: 'nonsense' }],
  ])('returns an empty list for %s', (_label, input) => {
    expect(readManifest(input).dependencies).toEqual([]);
  });
});

const CONTRIBUTORS = [
  { author: { login: 'ada' }, total: 90, weeks: [{ w: 1, a: 900, c: 90, d: 0 }] },
  { author: { login: 'bob' }, total: 10, weeks: [{ w: 1, a: 100, c: 10, d: 0 }] },
];

const slug = (name: string): RepoLocation => ({ owner: 'acme', repo: name });

/** Builds scan dependencies from per-package canned outcomes. */
const buildDeps = (spec: {
  registry?: Record<string, unknown>;
  stats?: Record<string, { ok: boolean; reason?: string; remedy?: string }>;
}): ScanDeps => ({
  registry: {
    async fetchPackageMetadata(name: string) {
      if (spec.registry && name in spec.registry) return spec.registry[name] as never;
      return { name, repository: { url: `https://github.com/acme/${name}.git` } } as never;
    },
  },
  repoChecker: {
    async checkRepo(location) {
      return { state: 'exists', archived: false, canonical: location } as never;
    },
  },
  stats: {
    async fetchContributorStats(location) {
      const outcome = spec.stats?.[location.repo];
      if (outcome && !outcome.ok) {
        return {
          ok: false,
          reason: outcome.reason ?? 'request-failed',
          detail: `stats unavailable for ${location.repo}`,
          ...(outcome.remedy ? { remedy: outcome.remedy } : {}),
        } as never;
      }
      return { ok: true, stats: CONTRIBUTORS } as never;
    },
  },
});

describe('scanDependencies', () => {
  it('analyses a resolvable dependency end to end', async () => {
    const [result] = await scanDependencies(
      { dependencies: ['widget'] },
      buildDeps({}),
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.report.truckFactor).toBe(1);
      expect(result.report.topAuthor.login).toBe('ada');
      expect(result.location).toEqual(slug('widget'));
    }
  });

  it('passes registry release and maintainer signals into the risk score', async () => {
    const [result] = await scanDependencies(
      { dependencies: ['owned'] },
      {
        ...buildDeps({
          registry: {
            owned: {
              repository: { url: 'https://github.com/acme/owned.git' },
              registrySignals: {
                lastPublish: {
                  known: true,
                  version: '1.0.0',
                  at: Date.parse('2020-01-01T00:00:00.000Z'),
                  ageDays: 0,
                },
                maintainers: { known: true, count: 1, names: ['owner'] },
              },
            },
          },
        }),
        now: () => Date.parse('2026-09-02T00:00:00.000Z'),
      },
    );

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.risk.factors).toContainEqual(
        expect.objectContaining({ signal: 'publish-recency', direction: 'up' }),
      );
    }
  });

  // The central guarantee: the output accounts for every input, so a report can
  // never quietly analyse fewer dependencies than the user actually has.
  it('returns one result per dependency even when some fail', async () => {
    const results = await scanDependencies(
      { dependencies: ['alpha', 'beta', 'gamma'] },
      buildDeps({
        registry: { beta: { name: 'beta' } },
        stats: { gamma: { ok: false, reason: 'saml-protected', remedy: 'grant access' } },
      }),
    );

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.packageName)).toEqual(['alpha', 'beta', 'gamma']);
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
  });

  it('preserves the failure reason and remedy from the stats client', async () => {
    const [result] = await scanDependencies(
      { dependencies: ['locked'] },
      buildDeps({
        stats: { locked: { ok: false, reason: 'saml-protected', remedy: 'grant token access' } },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'saml-protected',
      remedy: 'grant token access',
    });
  });

  it('reports an unresolvable dependency with its resolution reason', async () => {
    const [result] = await scanDependencies(
      { dependencies: ['orphan'] },
      buildDeps({ registry: { orphan: { name: 'orphan' } } }),
    );

    expect(result).toMatchObject({ ok: false, reason: 'no-repository-field' });
  });

  it('preserves input order despite concurrent execution', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `pkg-${i}`);

    const results = await scanDependencies({ dependencies: names }, {
      ...buildDeps({}),
      concurrency: 4,
    });

    expect(results.map((r) => r.packageName)).toEqual(names);
  });

  it('handles an empty dependency list', async () => {
    expect(await scanDependencies({ dependencies: [] }, buildDeps({}))).toEqual([]);
  });
});
