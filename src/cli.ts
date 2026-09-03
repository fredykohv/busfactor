#!/usr/bin/env node
/**
 * `busfactor scan` — the walking skeleton.
 *
 * Deliberately thin: wiring the modules together and printing. Argument
 * handling lives in `cli-options.ts` so it can be tested directly; all
 * judgement lives in the modules underneath.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createNpmRegistryClient, createGitHubRepoChecker } from './resolve-repo.js';
import { createGitHubStatsClient } from './stats-client.js';
import { readManifest, scanDependencies, type DependencyResult } from './scan.js';
import { compareByRisk } from './score.js';
import { renderMarkdownReport } from './report.js';
import { createFileCachedFetch } from './cache.js';
import {
  exitCodeFor,
  helpText,
  manifestErrorMessage,
  noTokenWarning,
  parseArgs,
  resolveCacheDirectory,
} from './cli-options.js';

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

const version = (): string => {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.kind === 'help') {
    console.log(helpText());
    return;
  }

  if (parsed.kind === 'version') {
    console.log(version());
    return;
  }

  if (parsed.kind === 'error') {
    console.error(parsed.message);
    process.exitCode = 1;
    return;
  }

  const options = parsed.options;

  let manifest;
  try {
    manifest = readManifest(JSON.parse(await readFile(options.manifestPath, 'utf8')), {
      includeDev: options.includeDev,
    });
  } catch (error) {
    console.error(manifestErrorMessage(options.manifestPath, error));
    process.exitCode = 1;
    return;
  }

  if (manifest.dependencies.length === 0) {
    console.log(
      options.includeDev
        ? `No dependencies or devDependencies listed in ${options.manifestPath}.`
        : `No dependencies listed in ${options.manifestPath}. Try --dev to include devDependencies.`,
    );
    return;
  }

  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  if (!token) console.error(noTokenWarning());

  const cacheDirectory = resolveCacheDirectory(process.env, process.cwd());
  const cachedFetch = createFileCachedFetch({ directory: cacheDirectory });

  // Progress on stderr, so `--json` and `--markdown` stay pipeable. A cold npx
  // run against a real project takes tens of seconds; silence reads as a hang.
  if (process.stderr.isTTY) {
    console.error(
      `Scanning ${manifest.dependencies.length} dependencies (cache: ${cacheDirectory})...`,
    );
  }

  const results = await scanDependencies(manifest, {
    registry: createNpmRegistryClient({ fetch: cachedFetch }),
    repoChecker: createGitHubRepoChecker(
      token === undefined ? { fetch: cachedFetch } : { token, fetch: cachedFetch },
    ),
    stats: createGitHubStatsClient(
      token === undefined ? { fetch: cachedFetch } : { token, fetch: cachedFetch },
    ),
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else if (options.markdown) {
    process.stdout.write(renderMarkdownReport(results));
  } else {
    printTable(results);
  }

  process.exitCode = exitCodeFor(results);
};

await main();
