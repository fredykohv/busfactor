import { describe, expect, it } from 'vitest';
import { renderMarkdownReport } from './report.js';
import type { DependencyResult } from './scan.js';

const analysed = (packageName: string, risk: number): DependencyResult => ({
  ok: true,
  packageName,
  location: { owner: 'acme', repo: packageName },
  archived: false,
  report: {
    kind: 'ok',
    truckFactor: 1,
    topAuthor: { login: 'alice', share: 0.95 },
    totalCommits: 100,
    unattributedCommits: 0,
    authorCount: { kind: 'exact', value: 2 },
    lines: { available: false, reason: 'no-line-data' },
  },
  risk: {
    total: risk,
    staleness: { kind: 'unknown' },
    factors: [
      {
        signal: 'top-author-share',
        points: 25,
        direction: 'up',
        reason: 'Top author has 95% commit share.',
      },
    ],
  },
});

describe('renderMarkdownReport', () => {
  it('ranks analysed entries and explains their score factors', () => {
    const report = renderMarkdownReport([analysed('low', 10), analysed('high', 80)]);

    expect(report.indexOf('`high`')).toBeLessThan(report.indexOf('`low`'));
    expect(report).toContain('| 1 | `high` | 80.0 |');
    expect(report).toContain('top-author-share +25.00: Top author has 95% commit share.');
    expect(report).toContain('no line data');
    expect(report).toContain('Analysed **2** of **2** direct dependencies; **0** skipped.');
  });

  it('includes skipped dependencies with reason, detail, and remedy', () => {
    const result: DependencyResult = {
      ok: false,
      packageName: 'missing',
      reason: 'saml-protected',
      detail: 'repository requires organisation access',
      remedy: 'grant token access and retry',
    };

    const report = renderMarkdownReport([result]);

    expect(report).toContain('Analysed **0** of **1** direct dependencies; **1** skipped.');
    expect(report).toContain('| `missing` | `saml-protected` | repository requires organisation access | grant token access and retry |');
  });

  // The repository verification step (not just contributor stats) can hit a
  // SAML-guarded or rate-limited GitHub response. Both must render as
  // first-class, actionable rows rather than a generic check-failed reason.
  it('renders a SAML-protected repository check with its remedy', () => {
    const result: DependencyResult = {
      ok: false,
      packageName: 'locked-repo',
      reason: 'repository-saml-protected',
      detail: 'repository is protected by organisation SAML enforcement',
      remedy: 'grant your GitHub token access to this organisation, then re-run',
    };

    const report = renderMarkdownReport([result]);

    expect(report).toContain('| `locked-repo` | `repository-saml-protected` |');
    expect(report).toContain('grant your GitHub token access to this organisation, then re-run');
  });

  it('renders a rate-limited repository check with its remedy', () => {
    const result: DependencyResult = {
      ok: false,
      packageName: 'busy-repo',
      reason: 'repository-rate-limited',
      detail: 'GitHub rate limit exhausted, resets at 2030-01-01T00:00:00.000Z',
      remedy: 'wait for the reset, or set GITHUB_TOKEN for a higher limit',
    };

    const report = renderMarkdownReport([result]);

    expect(report).toContain('| `busy-repo` | `repository-rate-limited` |');
    expect(report).toContain('resets at 2030-01-01T00:00:00.000Z');
    expect(report).toContain('wait for the reset, or set GITHUB_TOKEN for a higher limit');
  });

  it('does not render unknown signals as numeric zeroes', () => {
    const report = renderMarkdownReport([analysed('package', 1)]);

    expect(report).not.toContain('staleness +0');
    expect(report).not.toContain('maintainer-count +0');
    expect(report).toContain('Unknown signals are omitted rather than treated as zero.');
  });
});
