import { describe, expect, it } from 'vitest';
import {
  exitCodeFor,
  helpText,
  manifestErrorMessage,
  noTokenWarning,
  parseArgs,
  resolveCacheDirectory,
  resolveManifestPath,
} from './cli-options.js';

const run = (argv: readonly string[], cwd = '/proj') => parseArgs(argv, cwd);

describe('resolveManifestPath', () => {
  it('defaults to package.json in the working directory', () => {
    expect(resolveManifestPath('/proj', undefined)).toBe('/proj/package.json');
  });

  it('appends package.json to a directory argument', () => {
    expect(resolveManifestPath('/proj', 'apps/web')).toBe('/proj/apps/web/package.json');
  });

  it('accepts a direct path to a package.json without doubling it', () => {
    expect(resolveManifestPath('/proj', 'apps/web/package.json')).toBe(
      '/proj/apps/web/package.json',
    );
  });

  it('honours absolute paths', () => {
    expect(resolveManifestPath('/proj', '/elsewhere')).toBe('/elsewhere/package.json');
  });
});

describe('parseArgs', () => {
  it('treats a bare invocation as a scan of the working directory', () => {
    expect(run([])).toEqual({
      kind: 'run',
      options: {
        manifestPath: '/proj/package.json',
        includeDev: false,
        json: false,
        markdown: false,
      },
    });
  });

  it('accepts the scan command with a path and flags', () => {
    const parsed = run(['scan', './app', '--dev', '--json']);
    expect(parsed).toEqual({
      kind: 'run',
      options: {
        manifestPath: '/proj/app/package.json',
        includeDev: true,
        json: true,
        markdown: false,
      },
    });
  });

  it.each([['--help'], ['-h']])('reports help for %s', (flag) => {
    expect(run([flag])).toEqual({ kind: 'help' });
  });

  it.each([['--version'], ['-v']])('reports version for %s', (flag) => {
    expect(run([flag])).toEqual({ kind: 'version' });
  });

  it('rejects an unknown command rather than treating it as a path', () => {
    const parsed = run(['scna']);
    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' && parsed.message).toContain('Unknown command "scna"');
  });

  it('rejects a misspelled flag instead of silently ignoring it', () => {
    const parsed = run(['scan', '--markdwn']);
    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' && parsed.message).toContain('--markdwn');
  });

  it('rejects two output formats at once', () => {
    const parsed = run(['scan', '--json', '--markdown']);
    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' && parsed.message).toContain('not both');
  });

  it('rejects more than one path', () => {
    const parsed = run(['scan', 'a', 'b']);
    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' && parsed.message).toContain('at most one path');
  });
});

describe('resolveCacheDirectory', () => {
  it('prefers BUSFACTOR_CACHE_DIR', () => {
    expect(resolveCacheDirectory({ BUSFACTOR_CACHE_DIR: '/tmp/bf', HOME: '/home/x' }, '/proj')).toBe(
      '/tmp/bf',
    );
  });

  it('falls back to the home cache directory', () => {
    expect(resolveCacheDirectory({ HOME: '/home/x' }, '/proj')).toBe('/home/x/.cache/busfactor');
  });

  it('falls back to the working directory when HOME is unset', () => {
    expect(resolveCacheDirectory({}, '/proj')).toBe('/proj/.cache/busfactor');
  });
});

describe('exitCodeFor', () => {
  it('succeeds when at least one dependency was analysed', () => {
    expect(exitCodeFor([{ ok: true }, { ok: false }])).toBe(0);
  });

  it('succeeds on an empty result set', () => {
    expect(exitCodeFor([])).toBe(0);
  });

  it('fails when every dependency was skipped', () => {
    expect(exitCodeFor([{ ok: false }, { ok: false }])).toBe(1);
  });
});

describe('manifestErrorMessage', () => {
  it('suggests passing a path when the manifest is missing', () => {
    const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const message = manifestErrorMessage('/proj/package.json', error);
    expect(message).toContain('No package.json at /proj/package.json');
    expect(message).toContain('busfactor scan ./my-app');
  });

  it('reports a parse failure distinctly', () => {
    const message = manifestErrorMessage('/proj/package.json', new SyntaxError('Unexpected token'));
    expect(message).toContain('Unexpected token');
    expect(message).toContain('valid JSON');
  });
});

describe('help and warnings', () => {
  it('documents every user-visible option', () => {
    const text = helpText();
    for (const flag of ['--dev', '--json', '--markdown', '--help', '--version']) {
      expect(text).toContain(flag);
    }
    expect(text).toContain('BUSFACTOR_CACHE_DIR');
    expect(text).toContain('GITHUB_TOKEN');
  });

  it('tells the user how to set a token', () => {
    expect(noTokenWarning()).toContain('export GITHUB_TOKEN');
  });
});
