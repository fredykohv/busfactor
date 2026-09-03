import { describe, expect, it } from 'vitest';
import {
  createGitHubRepoChecker,
  parseRepositoryField,
  resolveRepo,
  resolveRepos,
  type PackageMetadata,
  type RegistryClient,
  type RepoChecker,
  type RepoLocation,
  type RepoStatus,
} from './resolve-repo.js';

function expectSlug(field: unknown, owner: string, repo: string, directory?: string) {
  const result = parseRepositoryField(field as never);
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.detail}`);
  expect(result.location.owner).toBe(owner);
  expect(result.location.repo).toBe(repo);
  expect(result.location.directory).toBe(directory);
}

function expectFailure(field: unknown, reason: string) {
  const result = parseRepositoryField(field as never);
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.location)}`);
  expect(result.reason).toBe(reason);
}

describe('parseRepositoryField — formats observed in the 591-package spike', () => {
  it('git+https (70.9% of the sample) — react', () => {
    expectSlug(
      { type: 'git', url: 'git+https://github.com/facebook/react.git' },
      'facebook',
      'react',
    );
  });

  it('git:// protocol (18.6%) — hapi, q, systemjs', () => {
    expectSlug({ type: 'git', url: 'git://github.com/hapijs/hapi.git' }, 'hapijs', 'hapi');
    expectSlug({ type: 'git', url: 'git://github.com/kriskowal/q.git' }, 'kriskowal', 'q');
  });

  it('plain https, no .git suffix (5.4%) — @gitbeaker/rest, escape-html', () => {
    expectSlug({ url: 'https://github.com/jdalrymple/gitbeaker' }, 'jdalrymple', 'gitbeaker');
    expectSlug({ url: 'https://github.com/component/escape-html' }, 'component', 'escape-html');
  });

  it('git+ssh://git@ (4.2%) — colors, libxmljs, aurelia-framework', () => {
    expectSlug(
      { type: 'git', url: 'git+ssh://git@github.com/Marak/colors.js.git' },
      'Marak',
      'colors.js',
    );
    expectSlug(
      { type: 'git', url: 'git+ssh://git@github.com/aurelia/framework.git' },
      'aurelia',
      'framework',
    );
  });

  it('bare owner/repo string shorthand — formidable', () => {
    expectSlug('node-formidable/formidable', 'node-formidable', 'formidable');
    expectSlug({ url: 'node-formidable/formidable' }, 'node-formidable', 'formidable');
  });

  it('plain string that is a full url — date-fns', () => {
    expectSlug('https://github.com/date-fns/date-fns', 'date-fns', 'date-fns');
  });

  it('github: / gh: npm shortcut syntax', () => {
    expectSlug('github:sindresorhus/chalk', 'sindresorhus', 'chalk');
    expectSlug('gh:sindresorhus/chalk', 'sindresorhus', 'chalk');
  });

  it('scp-like git@host:owner/repo', () => {
    expectSlug('git@github.com:tj/commander.js.git', 'tj', 'commander.js');
  });

  it('bare ssh:// and http://', () => {
    expectSlug('ssh://git@github.com/isaacs/node-glob.git', 'isaacs', 'node-glob');
    expectSlug('http://github.com/isaacs/once.git', 'isaacs', 'once');
  });

  it('www. prefix and trailing slash', () => {
    expectSlug('https://www.github.com/lodash/lodash/', 'lodash', 'lodash');
  });

  it('uppercase host', () => {
    expectSlug('https://GitHub.com/Marak/colors.js', 'Marak', 'colors.js');
  });
});

describe('parseRepositoryField — monorepo members (46 of 591 in the spike)', () => {
  it('preserves repository.directory — @babel/core', () => {
    expectSlug(
      {
        type: 'git',
        url: 'git+https://github.com/babel/babel.git',
        directory: 'packages/babel-core',
      },
      'babel',
      'babel',
      'packages/babel-core',
    );
  });

  it('normalises a leading ./ in directory — @aws-sdk style', () => {
    expectSlug(
      { url: 'git+https://github.com/aws/aws-sdk-js-v3.git', directory: './clients/client-s3/' },
      'aws',
      'aws-sdk-js-v3',
      'clients/client-s3',
    );
  });

  it('recovers a directory from a /tree/ url path — babel-core', () => {
    expectSlug(
      { url: 'https://github.com/babel/babel/tree/master/packages/babel-core' },
      'babel',
      'babel',
      'packages/babel-core',
    );
  });

  it('ignores an empty directory string', () => {
    expectSlug({ url: 'https://github.com/babel/babel.git', directory: '  ' }, 'babel', 'babel');
  });

  it('ignores a non-string directory', () => {
    expectSlug({ url: 'https://github.com/babel/babel.git', directory: 42 }, 'babel', 'babel');
  });
});

describe('parseRepositoryField — failures', () => {
  it('missing repository field — indexof, opentelemetry', () => {
    expectFailure(undefined, 'no-repository-field');
    expectFailure(null, 'no-repository-field');
  });

  it('object with no url', () => {
    expectFailure({ type: 'git' }, 'no-repository-field');
    expectFailure({ url: 42 }, 'no-repository-field');
  });

  it('empty url string', () => {
    expectFailure('', 'no-repository-field');
    expectFailure({ url: '   ' }, 'no-repository-field');
  });

  it('non-github host — @gitlab/ui, @gitlab/eslint-plugin', () => {
    expectFailure(
      { url: 'git+https://gitlab.com/gitlab-org/frontend/eslint-plugin.git' },
      'non-github-host',
    );
    expectFailure({ url: 'https://bitbucket.org/atlassian/some-lib.git' }, 'non-github-host');
    expectFailure('gitlab:gitlab-org/gitlab', 'non-github-host');
    expectFailure('bitbucket:team/repo', 'non-github-host');
    expectFailure({ url: 'git@git.example.com:internal/tool.git' }, 'non-github-host');
  });

  it('a plain website that is not a repo — stimulus', () => {
    expectFailure({ url: 'https://stimulus.hotwired.dev' }, 'non-github-host');
  });

  it('github url with no repo segment', () => {
    expectFailure('https://github.com/sindresorhus', 'malformed-repository-url');
    expectFailure('https://github.com/', 'malformed-repository-url');
  });

  it('genuinely unparseable url', () => {
    expectFailure({ url: 'not a url at all!!' }, 'malformed-repository-url');
  });

  it('surfaces the raw value on failure so reports can quote it', () => {
    const result = parseRepositoryField({ url: 'https://stimulus.hotwired.dev' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rawRepository).toBe('https://stimulus.hotwired.dev');
  });
});

// --- resolveRepo, with fake adapters (no network) ---------------------------

function registryOf(entries: Record<string, PackageMetadata | null>): RegistryClient {
  return {
    async fetchPackageMetadata(name) {
      if (!(name in entries)) throw new Error(`unexpected package ${name}`);
      return entries[name] ?? null;
    },
  };
}

function checkerOf(entries: Record<string, RepoStatus>): RepoChecker {
  return {
    async checkRepo(location: RepoLocation) {
      return entries[`${location.owner}/${location.repo}`] ?? { state: 'missing' };
    },
  };
}

const exists = (owner: string, repo: string, archived = false): RepoStatus => ({
  state: 'exists',
  archived,
  canonical: { owner, repo },
});

describe('resolveRepo', () => {
  it('resolves a healthy package', async () => {
    const result = await resolveRepo('chalk', {
      registry: registryOf({ chalk: { repository: 'git+https://github.com/chalk/chalk.git' } }),
      repoChecker: checkerOf({ 'chalk/chalk': exists('chalk', 'chalk') }),
    });
    expect(result).toEqual({
      ok: true,
      packageName: 'chalk',
      location: { owner: 'chalk', repo: 'chalk' },
      archived: false,
    });
  });

  it('reports archived repositories as a success with a flag', async () => {
    const result = await resolveRepo('request', {
      registry: registryOf({ request: { repository: 'git+https://github.com/request/request.git' } }),
      repoChecker: checkerOf({ 'request/request': exists('request', 'request', true) }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.archived).toBe(true);
  });

  it('follows a GitHub rename and records where it came from — popper.js', async () => {
    const result = await resolveRepo('popper.js', {
      registry: registryOf({
        'popper.js': { repository: 'git+https://github.com/FezVrasta/popper.js.git' },
      }),
      repoChecker: checkerOf({
        'FezVrasta/popper.js': exists('floating-ui', 'floating-ui'),
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location).toEqual({ owner: 'floating-ui', repo: 'floating-ui' });
    expect(result.redirectedFrom).toEqual({ owner: 'FezVrasta', repo: 'popper.js' });
  });

  it('keeps the monorepo directory across a rename', async () => {
    const result = await resolveRepo('@old/pkg', {
      registry: registryOf({
        '@old/pkg': {
          repository: { url: 'https://github.com/old/mono.git', directory: 'packages/pkg' },
        },
      }),
      repoChecker: checkerOf({ 'old/mono': exists('new', 'mono') }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.location).toEqual({ owner: 'new', repo: 'mono', directory: 'packages/pkg' });
    }
  });

  it('reports a repository that no longer exists — faker', async () => {
    const result = await resolveRepo('faker', {
      registry: registryOf({ faker: { repository: 'git+https://github.com/Marak/Faker.js.git' } }),
      repoChecker: checkerOf({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('repository-not-found');
  });

  it('reports a package that is not on the registry', async () => {
    const result = await resolveRepo('definitely-not-real', {
      registry: registryOf({ 'definitely-not-real': null }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('package-not-found');
  });

  it('reports registry transport failure rather than throwing', async () => {
    const result = await resolveRepo('anything', {
      registry: {
        async fetchPackageMetadata() {
          throw new Error('ECONNRESET');
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('registry-unavailable');
      expect(result.detail).toContain('ECONNRESET');
    }
  });

  it('reports GitHub transport failure separately from a missing repo', async () => {
    const result = await resolveRepo('chalk', {
      registry: registryOf({ chalk: { repository: 'https://github.com/chalk/chalk' } }),
      repoChecker: {
        async checkRepo() {
          throw new Error('rate limit exceeded');
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('repository-check-failed');
  });

  it('skips verification when no repoChecker is injected', async () => {
    const result = await resolveRepo('chalk', {
      registry: registryOf({ chalk: { repository: 'https://github.com/chalk/chalk' } }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.location).toEqual({ owner: 'chalk', repo: 'chalk' });
  });

  it('propagates parse failure reasons with the package name attached', async () => {
    const result = await resolveRepo('@gitlab/ui', {
      registry: registryOf({
        '@gitlab/ui': { repository: { url: 'git+https://gitlab.com/gitlab-org/x.git' } },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('non-github-host');
      expect(result.packageName).toBe('@gitlab/ui');
      expect(result.rawRepository).toContain('gitlab.com');
    }
  });
});

describe('resolveRepos', () => {
  it('never drops an unresolvable package and preserves order', async () => {
    const results = await resolveRepos(['chalk', 'indexof', '@gitlab/ui'], {
      registry: registryOf({
        chalk: { repository: 'https://github.com/chalk/chalk' },
        indexof: {},
        '@gitlab/ui': { repository: 'https://gitlab.com/gitlab-org/ui' },
      }),
    });
    expect(results.map((r) => r.packageName)).toEqual(['chalk', 'indexof', '@gitlab/ui']);
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
      'ok',
      'no-repository-field',
      'non-github-host',
    ]);
  });
});

// --- resolveRepo, propagating a forbidden verification result --------------

describe('resolveRepo — SAML/rate-limit/blocked from the repo checker', () => {
  const forbiddenChecker = (status: RepoStatus): RepoChecker => ({
    async checkRepo() {
      return status;
    },
  });

  it('reports repository-saml-protected with the remedy, not a generic check failure', async () => {
    const result = await resolveRepo('locked', {
      registry: registryOf({ locked: { repository: 'https://github.com/acme/locked' } }),
      repoChecker: forbiddenChecker({
        state: 'forbidden',
        reason: 'saml-protected',
        detail: 'repository is protected by organisation SAML enforcement',
        remedy: 'grant your GitHub token access to this organisation, then re-run',
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('repository-saml-protected');
    expect(result.remedy).toMatch(/grant/i);
  });

  it('reports repository-rate-limited from the repo checker', async () => {
    const result = await resolveRepo('busy', {
      registry: registryOf({ busy: { repository: 'https://github.com/acme/busy' } }),
      repoChecker: forbiddenChecker({
        state: 'forbidden',
        reason: 'rate-limited',
        detail: 'GitHub rate limit exhausted, resets at 2030-01-01T00:00:00.000Z',
        remedy: 'wait for the reset, or set GITHUB_TOKEN for a higher limit',
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('repository-rate-limited');
    expect(result.detail).toContain('2030');
  });

  it('falls back to repository-check-failed for an unclassified forbidden response', async () => {
    const result = await resolveRepo('blocked', {
      registry: registryOf({ blocked: { repository: 'https://github.com/acme/blocked' } }),
      repoChecker: forbiddenChecker({
        state: 'forbidden',
        reason: 'request-failed',
        detail: 'repository acme/blocked is unavailable for legal reasons',
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('repository-check-failed');
    expect(result.remedy).toBeUndefined();
  });
});

// --- createGitHubRepoChecker, with fake fetch (no network) ------------------

describe('createGitHubRepoChecker', () => {
  const location: RepoLocation = { owner: 'acme', repo: 'widget' };

  const stubFetch = (
    status: number,
    body?: unknown,
    headers?: Record<string, string>,
  ): typeof globalThis.fetch =>
    (async () =>
      new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
        ...(headers ? { headers } : {}),
      })) as unknown as typeof globalThis.fetch;

  it('classifies a SAML-protected 403 as forbidden/saml-protected', async () => {
    const checker = createGitHubRepoChecker({
      fetch: stubFetch(403, { message: 'Resource protected by organization SAML enforcement.' }),
    });

    const status = await checker.checkRepo(location);

    expect(status).toMatchObject({ state: 'forbidden', reason: 'saml-protected' });
    if (status.state === 'forbidden') expect(status.remedy).toMatch(/grant/i);
  });

  it('classifies an exhausted rate limit as forbidden/rate-limited', async () => {
    const reset = Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000);
    const checker = createGitHubRepoChecker({
      fetch: stubFetch(
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      ),
    });

    const status = await checker.checkRepo(location);

    expect(status).toMatchObject({ state: 'forbidden', reason: 'rate-limited' });
  });

  it('classifies a 451 as forbidden/request-failed with a legal-reasons detail', async () => {
    const checker = createGitHubRepoChecker({ fetch: stubFetch(451) });

    const status = await checker.checkRepo(location);

    expect(status).toMatchObject({ state: 'forbidden', reason: 'request-failed' });
    if (status.state === 'forbidden') expect(status.detail).toContain('legal reasons');
  });

  it('still reports a 404 as missing', async () => {
    const checker = createGitHubRepoChecker({ fetch: stubFetch(404) });

    expect(await checker.checkRepo(location)).toEqual({ state: 'missing' });
  });

  it('still resolves a healthy repository', async () => {
    const checker = createGitHubRepoChecker({
      fetch: stubFetch(200, { full_name: 'acme/widget', archived: false }),
    });

    expect(await checker.checkRepo(location)).toEqual({
      state: 'exists',
      archived: false,
      canonical: { owner: 'acme', repo: 'widget' },
    });
  });
});
