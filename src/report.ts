import { compareByRisk, type ScoredDependency } from './score.js';
import type { AnalysedDependency, DependencyResult } from './scan.js';

const markdownCell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

const factorText = (entry: AnalysedDependency): string => {
  if (entry.risk.factors.length === 0) return 'No material signals';

  return entry.risk.factors
    .map((factor) => {
      const sign = factor.direction === 'up' ? '+' : '-';
      return `${factor.signal} ${sign}${factor.points.toFixed(2)}: ${factor.reason}`;
    })
    .join('; ');
};

const asScored = (entry: AnalysedDependency): ScoredDependency<AnalysedDependency> => ({
  packageName: entry.packageName,
  score: entry.risk,
  meta: entry,
});

/**
 * Renders a complete Markdown report from scan results.
 *
 * Skipped dependencies are intentionally included in the output. A report
 * that only lists successful analyses creates false confidence by omission.
 */
export const renderMarkdownReport = (results: readonly DependencyResult[]): string => {
  const analysed = results
    .filter((entry): entry is AnalysedDependency => entry.ok)
    .map(asScored)
    .sort(compareByRisk)
    .map((entry) => entry.meta!);
  const skipped = results.filter((entry) => !entry.ok);

  const lines = [
    '# Dependency risk report',
    '',
    `Analysed **${analysed.length}** of **${results.length}** direct dependencies; **${skipped.length}** skipped.`,
    '',
    '## Ranked dependencies',
    '',
    '| Rank | Package | Risk | Truck factor | Top author | Top share | Flags |',
    '| ---: | --- | ---: | ---: | --- | ---: | --- |',
  ];

  analysed.forEach((entry, index) => {
    const flags = [
      entry.archived ? 'archived' : '',
      entry.redirectedFrom ? 'moved' : '',
      entry.report.lines.available ? '' : 'no line data',
    ].filter(Boolean);
    lines.push(
      `| ${index + 1} | \`${markdownCell(entry.packageName)}\` | ${entry.risk.total.toFixed(1)} | ${entry.report.truckFactor} | ${markdownCell(entry.report.topAuthor.login)} | ${Math.round(entry.report.topAuthor.share * 100)}% | ${flags.join(', ') || '-'} |`,
    );
  });

  if (analysed.length === 0) lines.push('| - | No dependencies analysed | - | - | - | - | - |');

  lines.push('', '## Why these scores', '');
  if (analysed.length === 0) {
    lines.push('No analysed dependencies have score factors to explain.');
  } else {
    lines.push('| Package | Score | Contributing signals |', '| --- | ---: | --- |');
    for (const entry of analysed) {
      lines.push(
        `| \`${markdownCell(entry.packageName)}\` | ${entry.risk.total.toFixed(1)} | ${markdownCell(factorText(entry))} |`,
      );
    }
  }

  lines.push(
    '',
    '## Skipped dependencies',
    '',
    skipped.length === 0
      ? 'None.'
      : '| Package | Reason | Detail | Remedy |',
    ...(skipped.length === 0
      ? []
      : [
          '| --- | --- | --- | --- |',
          ...skipped.map(
            (entry) =>
              `| \`${markdownCell(entry.packageName)}\` | \`${markdownCell(entry.reason)}\` | ${markdownCell(entry.detail)} | ${entry.remedy ? markdownCell(entry.remedy) : '-'} |`,
          ),
        ]),
    '',
    'Scores are heuristic and explainable, not a guarantee of maintainer behaviour. Unknown signals are omitted rather than treated as zero.',
  );

  return `${lines.join('\n')}\n`;
};
