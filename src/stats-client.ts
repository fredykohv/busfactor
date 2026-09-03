/**
 * Fetches contributor statistics from GitHub.
 *
 * The `/stats/contributors` endpoint is unusual in two ways that shape this
 * module:
 *
 *  1. It computes asynchronously. A cold repository returns `202` with an empty
 *     body, and the caller is expected to retry until the numbers appear.
 *  2. It fails in several distinct ways that call for *different actions from
 *     the user*. A SAML-protected repository is fixable by granting the token
 *     organisation access; a rate limit needs a wait; a deleted repository
 *     needs the dependency replaced. Collapsing these into one "unavailable"
 *     would waste the reader's time, so each is a separate reason.
 */

import type { ContributorStat } from './truck-factor.js';
import type { RepoLocation } from './resolve-repo.js';
import { classifyForbidden } from './github-forbidden.js';

export type StatsFailureReason =
  /** Repository is gone, renamed without a redirect, or private to us. */
  | 'not-found'
  /**
   * The token lacks organisation access, typically SAML SSO enforcement.
   * Actionable: the user can authorise their token for that organisation.
   */
  | 'saml-protected'
  /** Primary or secondary rate limit. Actionable: wait, or use a token. */
  | 'rate-limited'
  /** Legally blocked (DMCA and similar). */
  | 'blocked'
  /** GitHub never finished computing the stats within our retry budget. */
  | 'still-computing'
  /** Transport failure, or any status we don't specifically recognise. */
  | 'request-failed';

export type StatsResult =
  | { readonly ok: true; readonly stats: readonly ContributorStat[] }
  | {
      readonly ok: false;
      readonly reason: StatsFailureReason;
      /** Human-readable, safe to print in a report. */
      readonly detail: string;
      /** What the user could do about it, when there is something. */
      readonly remedy?: string;
    };

export interface StatsClient {
  fetchContributorStats(location: RepoLocation): Promise<StatsResult>;
}

export interface StatsClientOptions {
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Attempts to make while GitHub is still computing. Default 5. */
  readonly maxAttempts?: number;
  /** Injectable so tests never actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const failure = (
  reason: StatsFailureReason,
  detail: string,
  remedy?: string,
): StatsResult =>
  remedy === undefined
    ? { ok: false, reason, detail }
    : { ok: false, reason, detail, remedy };

export function createGitHubStatsClient(
  options: StatsClientOptions = {},
): StatsClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 5;

  return {
    async fetchContributorStats(location) {
      const url = `https://api.github.com/repos/${location.owner}/${location.repo}/stats/contributors`;
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'user-agent': 'truckguard',
      };
      if (options.token) headers['authorization'] = `Bearer ${options.token}`;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let response: Response;
        try {
          response = await doFetch(url, { headers });
        } catch (error) {
          return failure(
            'request-failed',
            `could not reach GitHub: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        if (response.status === 404) {
          return failure(
            'not-found',
            `GitHub has no repository ${location.owner}/${location.repo}`,
          );
        }
        if (response.status === 403 || response.status === 429) {
          const classified = classifyForbidden(await response.text(), response.headers);
          return failure(classified.reason, classified.detail, classified.remedy);
        }
        if (response.status === 451) {
          return failure('blocked', 'repository is unavailable for legal reasons');
        }

        // 202 means GitHub is computing the statistics. So, in practice, does a
        // 200 carrying an empty array — an undocumented but consistent
        // behaviour on cold repositories.
        if (response.status === 202) {
          if (attempt < maxAttempts) await sleep(1000 * attempt);
          continue;
        }

        if (!response.ok) {
          return failure(
            'request-failed',
            `GitHub returned ${response.status} ${response.statusText}`,
          );
        }

        const body = (await response.json()) as ContributorStat[] | unknown;
        if (!Array.isArray(body)) {
          return failure('request-failed', 'unexpected response shape from GitHub');
        }
        if (body.length === 0) {
          if (attempt < maxAttempts) {
            await sleep(1000 * attempt);
            continue;
          }
          // An empty array after exhausting retries is ambiguous: either still
          // computing, or a genuinely empty repository. Reported as computing,
          // since that is overwhelmingly the common case and the advice (retry)
          // is harmless either way.
          return failure(
            'still-computing',
            'GitHub did not finish computing contributor statistics',
            're-run in a moment; results are cached once computed',
          );
        }

        return { ok: true, stats: body as ContributorStat[] };
      }

      return failure(
        'still-computing',
        `GitHub was still computing statistics after ${maxAttempts} attempts`,
        're-run in a moment; results are cached once computed',
      );
    },
  };
}
