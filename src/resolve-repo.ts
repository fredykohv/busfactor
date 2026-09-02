/**
 * Resolves an npm package name to the GitHub repository that hosts its source.
 *
 * Two seams:
 *  - `parseRepositoryField` is pure. Everything we learned about the shapes the
 *    npm `repository` field takes in the wild lives here, and it is tested with
 *    zero network access.
 *  - `RegistryClient` / `RepoChecker` are the injectable IO adapters.
 *
 * Failure is a first-class result. A caller must always be able to say
 * "we could not analyse these N dependencies, and here is why".
 */

import { parseRegistrySignals, type RegistrySignals } from './registry-signals.js';

/** Where a package's source lives, once we've found it. */
export interface RepoLocation {
  readonly owner: string;
  readonly repo: string;
  /**
   * Subdirectory within a monorepo, from `repository.directory`.
   * Contributor stats are repo-wide, but downstream code needs to know a
   * package is one member of a larger repository.
   */
  readonly directory?: string;
}

export type ResolutionFailureReason =
  /** The package name does not exist on the registry. */
  | 'package-not-found'
  /** The registry could not be reached or returned an unusable response. */
  | 'registry-unavailable'
  /** The package has no `repository` field at all. */
  | 'no-repository-field'
  /** A `repository` field exists but points somewhere that isn't GitHub. */
  | 'non-github-host'
  /** A `repository` field exists but we cannot make a GitHub owner/repo of it. */
  | 'malformed-repository-url'
  /** We parsed a GitHub slug, but the repository no longer exists. */
  | 'repository-not-found'
  /** We parsed a GitHub slug, but GitHub could not be reached. */
  | 'repository-check-failed';

export interface ResolutionSuccess {
  readonly ok: true;
  readonly packageName: string;
  readonly location: RepoLocation;
  /** True when the GitHub repository is archived — a hard risk flag downstream. */
  readonly archived: boolean;
  readonly registrySignals?: RegistrySignals;
  /**
   * Set when the repository has been renamed or transferred and GitHub
   * redirected us. `location` holds the canonical slug; this holds what npm
   * metadata claimed.
   */
  readonly redirectedFrom?: RepoLocation;
}

export interface ResolutionFailure {
  readonly ok: false;
  readonly packageName: string;
  readonly reason: ResolutionFailureReason;
  /** Human-readable explanation, safe to print in a report. */
  readonly detail: string;
  /** The raw `repository` value we were given, when there was one. */
  readonly rawRepository?: string;
}

export type Resolution = ResolutionSuccess | ResolutionFailure;

/** The `repository` field as it appears in package metadata — string or object. */
export type RepositoryField =
  | string
  | { url?: unknown; directory?: unknown; type?: unknown }
  | null
  | undefined;

export type ParseResult =
  | { readonly ok: true; readonly location: RepoLocation }
  | {
      readonly ok: false;
      readonly reason: Extract<
        ResolutionFailureReason,
        'no-repository-field' | 'non-github-host' | 'malformed-repository-url'
      >;
      readonly detail: string;
      readonly rawRepository?: string;
    };

const NON_GITHUB_HOST_HINTS = [
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'git.sr.ht',
  'sourceforge.net',
  'gitee.com',
];

const SHORTCUT_HOSTS: Record<string, string | null> = {
  github: 'github.com',
  gh: 'github.com',
  gitlab: null,
  bitbucket: null,
  gist: null,
};

const BARE_SLUG = /^[\w.-]+\/[\w.-]+$/;

function fail(
  reason: Exclude<ParseResult, { ok: true }>['reason'],
  detail: string,
  rawRepository?: string,
): ParseResult {
  return rawRepository === undefined
    ? { ok: false, reason, detail }
    : { ok: false, reason, detail, rawRepository };
}

function nonGithub(raw: string): ParseResult {
  return fail('non-github-host', `repository is not hosted on GitHub: ${raw}`, raw);
}

/**
 * Normalise the many spellings of a git URL into something `URL` can parse.
 * Returns `null` when the input uses a known non-GitHub shortcut host.
 */
function normaliseToHttpsUrl(raw: string): string | null {
  let s = raw.trim();

  // `git+https://…`, `git+ssh://…`
  s = s.replace(/^git\+/i, '');

  // npm shortcut syntax: `github:owner/repo`, `gitlab:owner/repo`
  const shortcut = /^([a-z]+):([\w.-]+\/[\w.-]+)$/i.exec(s);
  if (shortcut) {
    const host = SHORTCUT_HOSTS[shortcut[1]!.toLowerCase()];
    if (host === undefined) return s; // unknown scheme, let URL parsing decide
    if (host === null) return null;
    return `https://${host}/${shortcut[2]}`;
  }

  // Bare `owner/repo` — npm treats this as GitHub.
  if (BARE_SLUG.test(s)) return `https://github.com/${s}`;

  // scp-like: `git@github.com:owner/repo.git`
  s = s.replace(/^[\w.-]+@([^:/]+):/, 'https://$1/');

  // `git://host/…` and `ssh://git@host/…`
  s = s.replace(/^git:\/\//i, 'https://');
  s = s.replace(/^ssh:\/\/(?:[\w.-]+@)?/i, 'https://');
  s = s.replace(/^http:\/\//i, 'https://');

  return s;
}

function cleanRepoName(segment: string): string {
  return segment.replace(/\.git$/i, '');
}

/**
 * Pure. Turns an npm `repository` field into a GitHub owner/repo, or an
 * explicit reason why it can't.
 */
export function parseRepositoryField(field: RepositoryField): ParseResult {
  if (field === null || field === undefined) {
    return fail('no-repository-field', 'package metadata has no repository field');
  }

  let rawUrl: string;
  let directory: string | undefined;

  if (typeof field === 'string') {
    rawUrl = field;
  } else if (typeof field === 'object') {
    const url = (field as { url?: unknown }).url;
    if (typeof url !== 'string') {
      return fail('no-repository-field', 'repository field has no usable url');
    }
    rawUrl = url;
    const dir = (field as { directory?: unknown }).directory;
    if (typeof dir === 'string' && dir.trim() !== '') {
      directory = dir.trim().replace(/^\.?\//, '').replace(/\/+$/, '');
    }
  } else {
    return fail('no-repository-field', `repository field has unusable type ${typeof field}`);
  }

  if (rawUrl.trim() === '') {
    return fail('no-repository-field', 'repository url is empty', rawUrl);
  }

  const normalised = normaliseToHttpsUrl(rawUrl);
  if (normalised === null) return nonGithub(rawUrl);

  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    return fail('malformed-repository-url', `could not parse repository url: ${rawUrl}`, rawUrl);
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (hostname !== 'github.com') {
    if (NON_GITHUB_HOST_HINTS.includes(hostname) || hostname.includes('.')) {
      return nonGithub(rawUrl);
    }
    return fail('malformed-repository-url', `could not parse repository url: ${rawUrl}`, rawUrl);
  }

  const segments = url.pathname.split('/').filter((s) => s !== '');
  const owner = segments[0];
  const repoSegment = segments[1];
  if (owner === undefined || repoSegment === undefined) {
    return fail(
      'malformed-repository-url',
      `repository url has no owner/repo path: ${rawUrl}`,
      rawUrl,
    );
  }

  const repo = cleanRepoName(repoSegment);
  if (repo === '') {
    return fail('malformed-repository-url', `repository url has empty repo name: ${rawUrl}`, rawUrl);
  }

  // Monorepo members frequently encode the subdirectory in the URL path
  // (`.../tree/master/packages/foo`) instead of `repository.directory`.
  if (directory === undefined && segments[2] === 'tree' && segments.length > 4) {
    const fromPath = segments.slice(4).join('/');
    if (fromPath !== '') directory = fromPath;
  }

  const location: RepoLocation =
    directory === undefined ? { owner, repo } : { owner, repo, directory };
  return { ok: true, location };
}

/** Minimal package metadata the resolver needs. */
export interface PackageMetadata {
  readonly repository?: RepositoryField;
  readonly registrySignals?: RegistrySignals;
}

/** Fetches package metadata from an npm registry. */
export interface RegistryClient {
  /** Returns `null` when the package does not exist. Throws on transport failure. */
  fetchPackageMetadata(packageName: string): Promise<PackageMetadata | null>;
}

export type RepoStatus =
  | { readonly state: 'exists'; readonly archived: boolean; readonly canonical: RepoLocation }
  | { readonly state: 'missing' };

/** Checks whether a GitHub repository still exists, and where it now lives. */
export interface RepoChecker {
  /** Throws on transport failure; returns `{ state: 'missing' }` for a 404. */
  checkRepo(location: RepoLocation): Promise<RepoStatus>;
}

export interface ResolveRepoDeps {
  readonly registry: RegistryClient;
  /** Optional. Without it, resolution stops at parsing and repos aren't verified. */
  readonly repoChecker?: RepoChecker;
}

function sameSlug(a: RepoLocation, b: RepoLocation): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves one npm package name to the GitHub repository hosting it.
 * Never throws: every failure mode comes back as a `ResolutionFailure`.
 */
export async function resolveRepo(
  packageName: string,
  deps: ResolveRepoDeps,
): Promise<Resolution> {
  let metadata: PackageMetadata | null;
  try {
    metadata = await deps.registry.fetchPackageMetadata(packageName);
  } catch (error) {
    return {
      ok: false,
      packageName,
      reason: 'registry-unavailable',
      detail: `could not fetch registry metadata: ${errorMessage(error)}`,
    };
  }

  if (metadata === null) {
    return {
      ok: false,
      packageName,
      reason: 'package-not-found',
      detail: `no such package on the registry: ${packageName}`,
    };
  }

  const parsed = parseRepositoryField(metadata.repository);
  if (!parsed.ok) {
    return parsed.rawRepository === undefined
      ? { ok: false, packageName, reason: parsed.reason, detail: parsed.detail }
      : {
          ok: false,
          packageName,
          reason: parsed.reason,
          detail: parsed.detail,
          rawRepository: parsed.rawRepository,
        };
  }

  const declared = parsed.location;
  const checker = deps.repoChecker;
  if (checker === undefined) {
    return {
      ok: true,
      packageName,
      location: declared,
      archived: false,
      ...(metadata.registrySignals === undefined ? {} : { registrySignals: metadata.registrySignals }),
    };
  }

  let status: RepoStatus;
  try {
    status = await checker.checkRepo(declared);
  } catch (error) {
    return {
      ok: false,
      packageName,
      reason: 'repository-check-failed',
      detail: `could not verify ${declared.owner}/${declared.repo}: ${errorMessage(error)}`,
    };
  }

  if (status.state === 'missing') {
    return {
      ok: false,
      packageName,
      reason: 'repository-not-found',
      detail: `repository ${declared.owner}/${declared.repo} no longer exists`,
    };
  }

  const canonical: RepoLocation =
    declared.directory === undefined
      ? { owner: status.canonical.owner, repo: status.canonical.repo }
      : {
          owner: status.canonical.owner,
          repo: status.canonical.repo,
          directory: declared.directory,
        };

  if (sameSlug(declared, canonical)) {
    return {
      ok: true,
      packageName,
      location: canonical,
      archived: status.archived,
      ...(metadata.registrySignals === undefined ? {} : { registrySignals: metadata.registrySignals }),
    };
  }

  return {
    ok: true,
    packageName,
    location: canonical,
    archived: status.archived,
    redirectedFrom: declared,
  };
}

/**
 * Resolves many packages, preserving input order. Unresolvable packages are
 * returned alongside resolved ones, never dropped.
 */
export async function resolveRepos(
  packageNames: readonly string[],
  deps: ResolveRepoDeps,
): Promise<Resolution[]> {
  return Promise.all(packageNames.map((name) => resolveRepo(name, deps)));
}

// --- Default network adapters ------------------------------------------------

export function createNpmRegistryClient(
  options: { readonly registryUrl?: string; readonly fetch?: typeof globalThis.fetch } = {},
): RegistryClient {
  const base = (options.registryUrl ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async fetchPackageMetadata(packageName) {
      const res = await doFetch(`${base}/${packageName.replace('/', '%2F')}`, {
        headers: { accept: 'application/json' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`registry responded ${res.status}`);
      const body = (await res.json()) as {
        repository?: RepositoryField;
        'dist-tags'?: { latest?: string };
        time?: Record<string, string | undefined>;
        maintainers?: readonly { name?: string }[];
        versions?: Record<string, { repository?: RepositoryField } | undefined>;
      };
      const latestTag = body['dist-tags']?.latest;
      const latest = latestTag === undefined ? undefined : body.versions?.[latestTag];
      const repository = latest?.repository ?? body.repository;
      return {
        ...(repository === undefined ? {} : { repository }),
        registrySignals: parseRegistrySignals(body, { now: Date.now() }),
      };
    },
  };
}

export function createGitHubRepoChecker(
  options: { readonly token?: string; readonly fetch?: typeof globalThis.fetch } = {},
): RepoChecker {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async checkRepo(location) {
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'user-agent': 'busfactor',
      };
      if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;

      const res = await doFetch(
        `https://api.github.com/repos/${location.owner}/${location.repo}`,
        { headers },
      );
      if (res.status === 404) return { state: 'missing' };
      if (!res.ok) throw new Error(`github responded ${res.status}`);
      const body = (await res.json()) as { full_name?: string; archived?: boolean };
      const parts = (body.full_name ?? `${location.owner}/${location.repo}`).split('/');
      const owner = parts[0] ?? location.owner;
      const repo = parts[1] ?? location.repo;
      return { state: 'exists', archived: body.archived === true, canonical: { owner, repo } };
    },
  };
}
