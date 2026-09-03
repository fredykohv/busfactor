import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileCacheOptions {
  readonly directory: string;
  readonly ttlMs?: number;
  readonly maxEntryBytes?: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

interface CacheEntry {
  readonly version: 1;
  readonly expiresAt: number;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly [string, string][];
  readonly body: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRY_BYTES = 5 * 1024 * 1024;

const cacheKey = (url: string, init?: RequestInit): string => {
  const method = init?.method ?? 'GET';
  return createHash('sha256').update(`${method}\n${url}`).digest('hex');
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const validEntry = (value: unknown): value is CacheEntry => {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.version === 1 &&
    typeof entry.expiresAt === 'number' &&
    typeof entry.status === 'number' &&
    typeof entry.statusText === 'string' &&
    Array.isArray(entry.headers) &&
    typeof entry.body === 'string'
  );
};

const responseFromEntry = (entry: CacheEntry): Response =>
  new Response(entry.body, {
    status: entry.status,
    statusText: entry.statusText,
    headers: Array.from(entry.headers),
  });

/**
 * Adds a persistent GET cache around fetch.
 *
 * Only successful, non-empty responses are cached. In particular, GitHub's
 * empty contributor response is a "still computing" signal, not a result.
 * Writes use a temporary file and rename so an interrupted process cannot
 * leave a partially written cache entry.
 */
export const createFileCachedFetch = (
  options: FileCacheOptions,
): typeof globalThis.fetch => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? globalThis.fetch;

  return async (input, init): Promise<Response> => {
    const request = new Request(input, init);
    if (request.method !== 'GET' || request.headers.get('cache-control') === 'no-store') {
      return doFetch(input, init);
    }

    const path = join(options.directory, `${cacheKey(request.url, init)}.json`);
    const currentTime = now();
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (validEntry(parsed) && parsed.expiresAt > currentTime) {
        return responseFromEntry(parsed);
      }
      await rm(path, { force: true });
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
    }

    const response = await doFetch(input, init);
    if (response.status !== 200) return response;

    const body = await response.clone().text();
    if (body.trim() === '' || body.trim() === '[]' || Buffer.byteLength(body) > maxEntryBytes) {
      return response;
    }

    await mkdir(options.directory, { recursive: true });
    const entry: CacheEntry = {
      version: 1,
      expiresAt: currentTime + ttlMs,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body,
    };
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, JSON.stringify(entry), 'utf8');
    await rename(temporary, path);
    return response;
  };
};
