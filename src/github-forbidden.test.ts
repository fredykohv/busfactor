import { describe, expect, it } from 'vitest';
import { classifyForbidden } from './github-forbidden.js';

describe('classifyForbidden — shared between the repo checker and the stats client', () => {
  it('detects SAML enforcement and suggests granting token access', () => {
    const result = classifyForbidden(
      JSON.stringify({ message: 'Resource protected by organization SAML enforcement.' }),
      new Headers(),
    );

    expect(result.reason).toBe('saml-protected');
    expect(result.remedy).toMatch(/grant/i);
  });

  it('detects an exhausted rate limit and reports the reset time', () => {
    const reset = Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000);
    const result = classifyForbidden(
      JSON.stringify({ message: 'API rate limit exceeded' }),
      new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
    );

    expect(result.reason).toBe('rate-limited');
    expect(result.detail).toContain('2030');
  });

  it('detects a secondary rate limit', () => {
    const result = classifyForbidden(
      JSON.stringify({ message: 'You have exceeded a secondary rate limit' }),
      new Headers(),
    );

    expect(result.reason).toBe('rate-limited');
  });

  it('falls back to request-failed for an unrecognised 403', () => {
    const result = classifyForbidden(
      JSON.stringify({ message: 'something else entirely' }),
      new Headers(),
    );

    expect(result.reason).toBe('request-failed');
    expect(result.remedy).toBeUndefined();
  });
});
