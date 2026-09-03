import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileCachedFetch } from './cache.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'busfactor-cache-'));
  directories.push(directory);
  return directory;
};

describe('createFileCachedFetch', () => {
  it('serves a successful response from disk on the second request', async () => {
    const directory = await setup();
    let calls = 0;
    const fetch = createFileCachedFetch({
      directory,
      now: () => 1_000,
      fetch: async () => {
        calls++;
        return new Response('payload', { status: 200, headers: { 'x-source': 'network' } });
      },
    });

    expect(await (await fetch('https://example.test/data')).text()).toBe('payload');
    expect(await (await fetch('https://example.test/data')).text()).toBe('payload');
    expect(calls).toBe(1);
  });

  it('does not cache empty contributor results', async () => {
    const directory = await setup();
    let calls = 0;
    const fetch = createFileCachedFetch({
      directory,
      fetch: async () => {
        calls++;
        return new Response('[]', { status: 200 });
      },
    });

    await fetch('https://api.github.com/repos/acme/widget/stats/contributors');
    await fetch('https://api.github.com/repos/acme/widget/stats/contributors');

    expect(calls).toBe(2);
  });

  it('expires entries according to the configured TTL', async () => {
    const directory = await setup();
    let now = 1_000;
    let calls = 0;
    const fetch = createFileCachedFetch({
      directory,
      ttlMs: 100,
      now: () => now,
      fetch: async () => {
        calls++;
        return new Response(String(calls), { status: 200 });
      },
    });

    expect(await (await fetch('https://example.test/data')).text()).toBe('1');
    now = 1_101;
    expect(await (await fetch('https://example.test/data')).text()).toBe('2');
    expect(calls).toBe(2);
  });

  it('ignores a corrupt cache entry and refreshes it', async () => {
    const directory = await setup();
    const key = createHash('sha256').update('GET\nhttps://example.test/data').digest('hex');
    const path = join(directory, `${key}.json`);
    await writeFile(path, '{not json');
    expect(await readFile(path, 'utf8')).toBe('{not json');

    let calls = 0;
    const fetch = createFileCachedFetch({
      directory,
      fetch: async () => {
        calls++;
        return new Response('fresh', { status: 200 });
      },
    });

    expect(await (await fetch('https://example.test/data')).text()).toBe('fresh');
    expect(calls).toBe(1);
  });

  it('bypasses cache for non-GET requests and no-store requests', async () => {
    const directory = await setup();
    let calls = 0;
    const fetch = createFileCachedFetch({
      directory,
      fetch: async () => {
        calls++;
        return new Response('ok', { status: 200 });
      },
    });

    await fetch('https://example.test/data', { method: 'POST' });
    await fetch('https://example.test/data', { headers: { 'cache-control': 'no-store' } });
    expect(calls).toBe(2);
  });
});
