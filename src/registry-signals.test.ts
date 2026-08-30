import { describe, expect, it } from 'vitest';
import {
  createNpmRegistrySignalsClient,
  parseRegistrySignals,
  type RegistryDocument,
} from './registry-signals.js';

const NOW = Date.parse('2026-09-01T00:00:00.000Z');

const doc = (over: Partial<RegistryDocument> = {}): RegistryDocument => ({
  'dist-tags': { latest: '2.0.0' },
  time: { '2.0.0': '2026-08-01T00:00:00.000Z' },
  maintainers: [{ name: 'alice' }],
  ...over,
});

/** A document with the key genuinely absent, not set to undefined. */
const docWithout = (key: keyof RegistryDocument): RegistryDocument => {
  const { [key]: _omitted, ...rest } = doc();
  return rest;
};

describe('parseRegistrySignals', () => {
  it('reads the publish date of the latest tag, not the modified timestamp', () => {
    // `time.modified` moves when *any* metadata changes, including a deprecation
    // or an owner edit, so it overstates how recently code actually shipped.
    const result = parseRegistrySignals(
      doc({
        time: {
          modified: '2026-08-30T00:00:00.000Z',
          '2.0.0': '2026-08-01T00:00:00.000Z',
        },
      }),
      { now: NOW },
    );

    expect(result.lastPublish).toEqual({
      known: true,
      version: '2.0.0',
      at: Date.parse('2026-08-01T00:00:00.000Z'),
      ageDays: 31,
    });
  });

  it('counts maintainers exactly when the field is present', () => {
    const result = parseRegistrySignals(
      doc({ maintainers: [{ name: 'alice' }, { name: 'bob' }] }),
      { now: NOW },
    );

    expect(result.maintainers).toEqual({ known: true, count: 2, names: ['alice', 'bob'] });
  });

  it('reports a sole maintainer, the case the tool exists to surface', () => {
    const result = parseRegistrySignals(doc(), { now: NOW });

    expect(result.maintainers).toEqual({ known: true, count: 1, names: ['alice'] });
  });

  describe('when data is missing', () => {
    // Every one of these asserts the absent branch carries NO numeric member.
    // A caller must not be able to read a 0 and mistake it for a measurement.

    it('does not invent a publish date when the latest tag has no timestamp', () => {
      const result = parseRegistrySignals(doc({ time: {} }), { now: NOW });

      expect(result.lastPublish).toEqual({ known: false, reason: 'no-timestamp' });
      expect(result.lastPublish).not.toHaveProperty('ageDays');
    });

    it('does not invent a publish date when there is no latest tag', () => {
      const result = parseRegistrySignals(doc({ 'dist-tags': {} }), { now: NOW });

      expect(result.lastPublish).toEqual({ known: false, reason: 'no-latest-version' });
      expect(result.lastPublish).not.toHaveProperty('ageDays');
    });

    it('does not report zero maintainers when the field is absent', () => {
      const result = parseRegistrySignals(docWithout('maintainers'), { now: NOW });

      expect(result.maintainers).toEqual({ known: false });
      expect(result.maintainers).not.toHaveProperty('count');
    });

    it('treats an empty maintainer array as unknown rather than zero', () => {
      // Nobody can publish a package with zero owners, so an empty array is a
      // metadata artefact, not a finding. Reporting "0 maintainers" would be
      // a more alarming claim than the truth.
      const result = parseRegistrySignals(doc({ maintainers: [] }), { now: NOW });

      expect(result.maintainers).toEqual({ known: false });
    });

    it('ignores an unparseable timestamp', () => {
      const result = parseRegistrySignals(doc({ time: { '2.0.0': 'not a date' } }), { now: NOW });

      expect(result.lastPublish).toEqual({ known: false, reason: 'no-timestamp' });
    });
  });

  describe('age', () => {
    it('floors partial days so a fresh publish reads as 0 rather than 1', () => {
      const result = parseRegistrySignals(
        doc({ time: { '2.0.0': '2026-08-31T12:00:00.000Z' } }),
        { now: NOW },
      );

      expect(result.lastPublish).toMatchObject({ known: true, ageDays: 0 });
    });

    it('measures a genuinely abandoned package in years, not weeks', () => {
      // left-pad's real last publish. This is the case the signal exists for.
      const result = parseRegistrySignals(
        doc({ 'dist-tags': { latest: '1.3.0' }, time: { '1.3.0': '2018-04-09T00:00:00.000Z' } }),
        { now: NOW },
      );

      expect(result.lastPublish).toMatchObject({ known: true, ageDays: 3067 });
    });

    it('never reports a negative age when a timestamp is in the future', () => {
      // Clock skew between the registry and the caller must not produce a
      // nonsense value that a scoring model would then reward.
      const result = parseRegistrySignals(
        doc({ time: { '2.0.0': '2026-12-01T00:00:00.000Z' } }),
        { now: NOW },
      );

      expect(result.lastPublish).toMatchObject({ known: true, ageDays: 0 });
    });
  });
});

describe('createNpmRegistrySignalsClient', () => {
  const okResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('requests the abbreviated-safe document and parses it', async () => {
    const calls: string[] = [];
    const client = createNpmRegistrySignalsClient({
      now: () => NOW,
      fetch: async (input) => {
        calls.push(String(input));
        return okResponse(doc());
      },
    });

    const result = await client.fetchSignals('yaml');

    expect(calls).toEqual(['https://registry.npmjs.org/yaml']);
    expect(result).toMatchObject({ maintainers: { known: true, count: 1 } });
  });

  it('encodes the slash in a scoped package name', async () => {
    const calls: string[] = [];
    const client = createNpmRegistrySignalsClient({
      now: () => NOW,
      fetch: async (input) => {
        calls.push(String(input));
        return okResponse(doc());
      },
    });

    await client.fetchSignals('@types/node');

    expect(calls).toEqual(['https://registry.npmjs.org/@types%2Fnode']);
  });

  it('returns null for a package that does not exist', async () => {
    const client = createNpmRegistrySignalsClient({
      now: () => NOW,
      fetch: async () => new Response('', { status: 404 }),
    });

    await expect(client.fetchSignals('nope')).resolves.toBeNull();
  });

  it('throws on an unexpected status rather than reporting absent signals', async () => {
    // A 500 means we do not know. Silently degrading to "no maintainer data"
    // would let an outage look like a clean result.
    const client = createNpmRegistrySignalsClient({
      now: () => NOW,
      fetch: async () => new Response('', { status: 500 }),
    });

    await expect(client.fetchSignals('yaml')).rejects.toThrow(/500/);
  });
});
