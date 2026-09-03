#!/usr/bin/env node
/**
 * `busfactor scan` — the walking skeleton.
 *
 * Deliberately thin: argument parsing, wiring the modules together, and
 * printing. All judgement lives in the modules underneath.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNpmRegistryClient, createGitHubRepoChecker } from './resolve-repo.js';
import { createGitHubStatsClient } from './stats-client.js';
import { readManifest, scanDependencies, type DependencyResult } from './scan.js';
import { compareByRisk } from './score.js';
import { renderMarkdownReport } from './report.js';
import { createFileCachedFetch } from './cache.js';

interface Options {
  readonly manifestPath: string;
  readonly includeDev: boolean;
  readonly json: boolean;
  readonly markdown: boolean;
}

const parseArgs = (argv: readonly string[]): Options => ({
  manifestPath: resolve(
    argv.find((arg) => !arg.startsWith('-') && arg !== 'scan') ?? process.cwd(),
    'package.json',
  ),
  includeDev: argv.includes('--dev'),
  json: argv.includes('--json'),
  markdown: argv.includes('--markdown'),
});

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Orders analysed results by the explainable M2 risk score. Skipped
 * dependencies remain at the bottom so the report accounts for every input.
 */
const byRisk = (a: DependencyResult, b: DependencyResult): number => {
  if (!a.ok || !b.ok) return a.ok ? -1 : b.ok ? 1 : 0;
  return compareByRisk(
    { packageName: a.packageName, score: a.risk },
    { packageName: b.packageName, score: b.risk },
  );
};

const printTable = (results: readonly DependencyResult[]): void => {
  const analysed = results.filter((r): r is Extract<DependencyResult, { ok: true }> => r.ok);
  const skipped = results.filter((r): r is Extract<DependencyResult, { ok: false }> => !r.ok);

  if (analysed.length > 0) {
    const width = Math.max(...analysed.map((r) => r.packageName.length), 7);
    console.log('');
    console.log(
      `${'package'.padEnd(width)}  ${'risk'.padEnd(5)} ${'TF'.padEnd(3)} ${'top'.padEnd(5)} author`,
    );
    console.log('-'.repeat(width + 38));

    for (const entry of [...analysed].sort(byRisk)) {
      const flags = [
        entry.archived ? 'ARCHIVED' : '',
        entry.redirectedFrom ? 'moved' : '',
        entry.report.lines.available ? '' : 'no line data',
      ].filter(Boolean);

      console.log(
        `${entry.packageName.padEnd(width)}  ` +
          `${entry.risk.total.toFixed(1).padEnd(5)} ` +
          `${String(entry.report.truckFactor).padEnd(3)} ` +
          `${pct(entry.report.topAuthor.share).padEnd(5)} ` +
          `${entry.report.topAuthor.login}` +
          (flags.length > 0 ? `  [${flags.join(', ')}]` : ''),
      );
    }
  }

  // Skipped dependencies are printed, never dropped. A report that quietly
  // analyses 57 of 61 dependencies is lying by omission.
  if (skipped.length > 0) {
    console.log(`\nCould not analyse ${skipped.length} of ${results.length}:`);
    for (const entry of skipped) {
      console.log(
        `  ${entry.packageName}: ${entry.detail}` +
          (entry.remedy ? `\n    -> ${entry.remedy}` : ''),
      );
    }
  }

  console.log(
    `\n${analysed.length} analysed, ${skipped.length} skipped, ${results.length} total.`,
  );
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));

  let manifest;
  try {
    manifest = readManifest(
      JSON.parse(await readFile(options.manifestPath, 'utf8')),
      { includeDev: options.includeDev },
    );
  } catch (error) {
    console.error(
      `Could not read ${options.manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  if (manifest.dependencies.length === 0) {
    console.log('No dependencies found.');
    return;
  }

  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  if (!token) {
    console.error(
      'Warning: no GITHUB_TOKEN set. GitHub allows only 60 unauthenticated\n' +
        'requests per hour, which is not enough for most dependency lists.\n',
    );
  }

  const cacheDirectory = resolve(
    process.env['BUSFACTOR_CACHE_DIR'] ??
      `${process.env['HOME'] ?? process.cwd()}/.cache/busfactor`,
  );
  const cachedFetch = createFileCachedFetch({ directory: cacheDirectory });

  const results = await scanDependencies(manifest, {
    registry: createNpmRegistryClient({ fetch: cachedFetch }),
    repoChecker: createGitHubRepoChecker(
      token === undefined
        ? { fetch: cachedFetch }
        : { token, fetch: cachedFetch },
    ),
    stats: createGitHubStatsClient(
      token === undefined
        ? { fetch: cachedFetch }
        : { token, fetch: cachedFetch },
    ),
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (options.markdown) {
    process.stdout.write(renderMarkdownReport(results));
    return;
  }

  printTable(results);
};

await main();
