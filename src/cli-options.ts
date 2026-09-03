/**
 * Pure argument handling for `busfactor`.
 *
 * Kept out of `cli.ts` so every user-visible decision — what a flag means, what
 * a bad invocation says, which exit code a run deserves — is testable without
 * spawning a process or touching the network.
 */

import { basename, isAbsolute, resolve } from 'node:path';

export interface RunOptions {
  readonly manifestPath: string;
  readonly includeDev: boolean;
  readonly json: boolean;
  readonly markdown: boolean;
  readonly markdownOutputPath?: string;
}

export type ParsedArgs =
  | { readonly kind: 'run'; readonly options: RunOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string };

const KNOWN_FLAGS = new Set([
  '--dev',
  '--json',
  '--markdown',
  '--output',
  '--help',
  '-h',
  '--version',
  '-v',
]);

/**
 * Accepts either a directory or a direct path to a `package.json`. Pointing at
 * the manifest is what people try first, and silently appending `package.json`
 * to it produced `package.json/package.json` — a confusing ENOENT.
 */
export const resolveManifestPath = (cwd: string, target: string | undefined): string => {
  const base = target === undefined ? cwd : isAbsolute(target) ? target : resolve(cwd, target);
  return basename(base) === 'package.json' ? base : resolve(base, 'package.json');
};

/** Cache location, honouring `BUSFACTOR_CACHE_DIR`. */
export const resolveCacheDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string =>
  resolve(env['BUSFACTOR_CACHE_DIR'] ?? `${env['HOME'] ?? cwd}/.cache/busfactor`);

export const helpText = (): string =>
  [
    'busfactor — rank your direct npm dependencies by maintainer concentration.',
    '',
    'Usage:',
    '  busfactor scan [path] [options]',
    '',
    'Arguments:',
    '  path            Directory containing a package.json, or a path to one.',
    '                  Defaults to the current directory.',
    '',
    'Options:',
    '  --dev           Include devDependencies as well as dependencies.',
    '  --json          Emit the full result set as JSON.',
    '  --markdown      Emit an explainable Markdown report.',
    '  --output <path> Write Markdown output to a deterministic file path',
    '                  (requires --markdown).',
    '  -h, --help      Show this help.',
    '  -v, --version   Show the version.',
    '',
    'Environment:',
    '  GITHUB_TOKEN / GH_TOKEN   Raises the GitHub rate limit from 60 to 5000',
    '                            requests per hour. Strongly recommended.',
    '  BUSFACTOR_CACHE_DIR       Cache location. Defaults to ~/.cache/busfactor.',
    '',
    'Exit codes:',
    '  0  The scan ran; some dependencies may be reported as skipped.',
    '  1  Bad usage, an unreadable manifest, or no dependency could be analysed.',
    '',
  ].join('\n');

export const noTokenWarning = (): string =>
  [
    'Warning: no GITHUB_TOKEN set. GitHub allows only 60 unauthenticated requests',
    'per hour, which is not enough for most dependency lists — expect skipped',
    'entries below.',
    '',
    '  export GITHUB_TOKEN="$(gh auth token)"   # or a classic token, no scopes needed',
    '',
  ].join('\n');

/**
 * Parses `busfactor` arguments. Unknown flags are an error rather than being
 * ignored: silently dropping a misspelled `--markdwn` and printing a table is
 * worse than saying so.
 */
export const parseArgs = (
  argv: readonly string[],
  cwd: string = process.cwd(),
): ParsedArgs => {
  const args = argv[0] === 'scan' ? argv.slice(1) : argv;

  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  if (args.includes('--version') || args.includes('-v')) return { kind: 'version' };

  if (argv[0] !== undefined && argv[0] !== 'scan' && argv[0].startsWith('-') === false) {
    return {
      kind: 'error',
      message: `Unknown command "${argv[0]}". The only command is "scan"; run "busfactor --help".`,
    };
  }

  const unknown = args.find((arg) => arg.startsWith('-') && !KNOWN_FLAGS.has(arg));
  if (unknown !== undefined) {
    return { kind: 'error', message: `Unknown option "${unknown}". Run "busfactor --help".` };
  }

  const json = args.includes('--json');
  const markdown = args.includes('--markdown');
  if (json && markdown) {
    return { kind: 'error', message: 'Use either --json or --markdown, not both.' };
  }

  const outputIndices = args
    .map((arg, index) => (arg === '--output' ? index : -1))
    .filter((index) => index >= 0);
  if (outputIndices.length > 1) {
    return { kind: 'error', message: 'Use --output at most once.' };
  }

  const outputIndex = outputIndices[0];
  const outputPath =
    outputIndex === undefined
      ? undefined
      : args[outputIndex + 1] !== undefined && !args[outputIndex + 1]!.startsWith('-')
        ? args[outputIndex + 1]!
        : undefined;

  if (outputIndex !== undefined && outputPath === undefined) {
    return { kind: 'error', message: 'Expected a file path after --output.' };
  }

  if (outputPath !== undefined && !markdown) {
    return { kind: 'error', message: '--output requires --markdown.' };
  }

  const positional = args.filter((arg, index) => {
    if (arg === '--output') return false;
    if (outputIndex !== undefined && index === outputIndex + 1) return false;
    return !arg.startsWith('-');
  });
  if (positional.length > 1) {
    return {
      kind: 'error',
      message: `Expected at most one path, got ${positional.length}: ${positional.join(', ')}.`,
    };
  }

  return {
    kind: 'run',
    options: {
      manifestPath: resolveManifestPath(cwd, positional[0]),
      includeDev: args.includes('--dev'),
      json,
      markdown,
      ...(outputPath === undefined ? {} : { markdownOutputPath: outputPath }),
    },
  };
};

/**
 * A run that skipped some dependencies still succeeded — skips are reported,
 * not hidden. A run where *nothing* could be analysed did not, and CI should
 * hear about it.
 */
export const exitCodeFor = (results: readonly { readonly ok: boolean }[]): number =>
  results.length > 0 && results.every((result) => !result.ok) ? 1 : 0;

/** Explains an unreadable manifest in terms of what the user should do next. */
export const manifestErrorMessage = (manifestPath: string, error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);
  const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';

  return missing
    ? `No package.json at ${manifestPath}.\n` +
        '  -> Run busfactor from a project directory, or pass a path: busfactor scan ./my-app'
    : `Could not read ${manifestPath}: ${detail}\n` +
        '  -> Check that the file is valid JSON.';
};
