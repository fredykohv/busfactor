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

  it('does not render unknown signals as numeric zeroes', () => {
    const report = renderMarkdownReport([analysed('package', 1)]);

    expect(report).not.toContain('staleness +0');
    expect(report).not.toContain('maintainer-count +0');
    expect(report).toContain('Unknown signals are omitted rather than treated as zero.');
  });
});
