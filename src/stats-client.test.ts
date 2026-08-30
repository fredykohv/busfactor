import { describe, expect, it } from 'vitest';
import { createGitHubStatsClient } from './stats-client.js';

const LOCATION = { owner: 'acme', repo: 'widget' };

const noSleep = async (): Promise<void> => {};

/** Builds a fetch stub that replays the given responses in order. */
const stubFetch = (
  responses: readonly { status: number; body?: unknown; headers?: Record<string, string> }[],
): { fetch: typeof globalThis.fetch; calls: () => number } => {
  let index = 0;
  const fetchStub = (async () => {
    const spec = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return new Response(
      spec.body === undefined ? '' : JSON.stringify(spec.body),
      { status: spec.status, ...(spec.headers ? { headers: spec.headers } : {}) },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchStub, calls: () => index };
};

const client = (
  responses: Parameters<typeof stubFetch>[0],
  maxAttempts = 3,
): ReturnType<typeof createGitHubStatsClient> & { calls: () => number } => {
  const { fetch, calls } = stubFetch(responses);
  const c = createGitHubStatsClient({ fetch, sleep: noSleep, maxAttempts });
  return Object.assign(c, { calls });
};

const CONTRIBUTORS = [
  { author: { login: 'ada' }, total: 10, weeks: [{ w: 1, a: 5, c: 10, d: 1 }] },
];

describe('createGitHubStatsClient', () => {
  it('returns stats on a successful response', async () => {
    const result = await client([{ status: 200, body: CONTRIBUTORS }])
      .fetchContributorStats(LOCATION);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stats).toHaveLength(1);
  });

  it('retries while GitHub is computing, then succeeds', async () => {
    const c = client([
      { status: 202 },
      { status: 200, body: [] },
      { status: 200, body: CONTRIBUTORS },
    ]);

    const result = await c.fetchContributorStats(LOCATION);

    expect(result.ok).toBe(true);
    expect(c.calls()).toBe(3);
  });

  it('gives up with still-computing after exhausting attempts', async () => {
    const result = await client([{ status: 202 }], 3).fetchContributorStats(LOCATION);

    expect(result).toMatchObject({ ok: false, reason: 'still-computing' });
    if (!result.ok) expect(result.remedy).toBeDefined();
  });

  // A 200 with an empty array is GitHub's undocumented "still computing"
  // signal, and must not be mistaken for a repository with no contributors.
  it('treats a persistently empty array as still-computing, not as empty stats', async () => {
    const result = await client([{ status: 200, body: [] }], 2)
      .fetchContributorStats(LOCATION);

    expect(result).toMatchObject({ ok: false, reason: 'still-computing' });
  });

  it('reports a 404 as not-found without retrying', async () => {
    const c = client([{ status: 404 }]);

    const result = await c.fetchContributorStats(LOCATION);

    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
    expect(c.calls()).toBe(1);
  });

  // GitHub overloads 403. Each meaning needs different advice, so each is
  // classified separately rather than collapsed into one failure.
  describe('classifying 403 responses', () => {
    it('detects SAML enforcement and suggests granting token access', async () => {
      const result = await client([
        {
          status: 403,
          body: { message: 'Resource protected by organization SAML enforcement.' },
        },
      ]).fetchContributorStats(LOCATION);

      expect(result).toMatchObject({ ok: false, reason: 'saml-protected' });
      if (!result.ok) expect(result.remedy).toMatch(/grant/i);
    });

    it('detects an exhausted rate limit and reports the reset time', async () => {
      const reset = Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000);
      const result = await client([
        {
          status: 403,
          body: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        },
      ]).fetchContributorStats(LOCATION);

      expect(result).toMatchObject({ ok: false, reason: 'rate-limited' });
      if (!result.ok) expect(result.detail).toContain('2030');
    });

    it('detects a secondary rate limit', async () => {
      const result = await client([
        { status: 403, body: { message: 'You have exceeded a secondary rate limit' } },
      ]).fetchContributorStats(LOCATION);

      expect(result).toMatchObject({ ok: false, reason: 'rate-limited' });
    });

    it('falls back to request-failed for an unrecognised 403', async () => {
      const result = await client([
        { status: 403, body: { message: 'something else entirely' } },
      ]).fetchContributorStats(LOCATION);

      expect(result).toMatchObject({ ok: false, reason: 'request-failed' });
    });
  });

  it('reports a 451 as blocked', async () => {
    const result = await client([{ status: 451 }]).fetchContributorStats(LOCATION);

    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('reports transport failure without throwing', async () => {
    const failing = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof globalThis.fetch;

    const result = await createGitHubStatsClient({ fetch: failing, sleep: noSleep })
      .fetchContributorStats(LOCATION);

    expect(result).toMatchObject({ ok: false, reason: 'request-failed' });
    if (!result.ok) expect(result.detail).toContain('socket hang up');
  });
});
