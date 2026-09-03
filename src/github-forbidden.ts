/**
 * Shared classification of GitHub's overloaded 403 response.
 *
 * Both the repository checker (`resolve-repo.ts`) and the contributor stats
 * client (`stats-client.ts`) hit GitHub's REST API and both can receive a 403
 * for entirely different reasons: SAML SSO enforcement, a primary or
 * secondary rate limit, or something else entirely. The right advice to the
 * user differs completely in each case, so this logic is factored out once
 * and shared rather than reimplemented — and potentially drifting — in both
 * places.
 */

export type ForbiddenReason = 'saml-protected' | 'rate-limited' | 'request-failed';

export interface ForbiddenClassification {
  readonly reason: ForbiddenReason;
  readonly detail: string;
  readonly remedy?: string;
}

const classification = (
  reason: ForbiddenReason,
  detail: string,
  remedy?: string,
): ForbiddenClassification =>
  remedy === undefined ? { reason, detail } : { reason, detail, remedy };

/**
 * Distinguishes the several meanings of a 403 from GitHub.
 *
 * GitHub overloads 403 for SAML enforcement, rate limiting and legal blocks.
 * The response body and headers are the only way to tell them apart, and the
 * right advice differs completely in each case.
 */
export function classifyForbidden(body: string, headers: Headers): ForbiddenClassification {
  if (/SAML enforcement/i.test(body)) {
    return classification(
      'saml-protected',
      'repository is protected by organisation SAML enforcement',
      'grant your GitHub token access to this organisation, then re-run',
    );
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = headers.get('x-ratelimit-reset');
    const when = reset ? new Date(Number(reset) * 1000).toISOString() : 'shortly';
    return classification(
      'rate-limited',
      `GitHub rate limit exhausted, resets at ${when}`,
      'wait for the reset, or set GITHUB_TOKEN for a higher limit',
    );
  }
  if (/secondary rate limit/i.test(body)) {
    return classification(
      'rate-limited',
      'hit a GitHub secondary rate limit',
      'reduce concurrency and re-run',
    );
  }
  return classification('request-failed', `GitHub returned 403: ${body.slice(0, 120)}`);
}
