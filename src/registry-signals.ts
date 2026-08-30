/**
 * Registry-derived risk signals: how recently a package actually shipped, and
 * how many accounts can publish it.
 *
 * These are separate from the repository signals in `truck-factor.ts` because
 * they answer a different question. Commit history says who *writes* the code;
 * npm ownership says who can *release* it. The two diverge, and the gap matters:
 * a package can have a healthy contributor graph and still have exactly one
 * account able to cut a release.
 *
 * `yaml` is the motivating case. It has a truck factor of 1 with 95% of commits
 * by `eemeli`, and exactly one npm maintainer, also `eemeli`. Those are not two
 * independent risks; they are the same person counted twice, and a scoring model
 * that adds them naively will double-count. Reporting them as distinct signals
 * lets the model decide, rather than burying the correlation here.
 *
 * Everything in this module is pure except the adapter at the bottom.
 */

// --- Types -------------------------------------------------------------------

/** The subset of an npm registry document we read. */
export interface RegistryDocument {
  readonly 'dist-tags'?: { readonly latest?: string };
  /** Version -> ISO timestamp, plus the `created`/`modified` special keys. */
  readonly time?: Record<string, string | undefined>;
  readonly maintainers?: readonly { readonly name?: string }[];
}

/**
 * When the package last shipped code.
 *
 * The unknown branch carries no numeric members, so a caller cannot read an
 * `ageDays` of 0 and conclude the package was published today. This mirrors how
 * `LineSignal` models missing line data in `truck-factor.ts`.
 */
export type LastPublishSignal =
  | {
      readonly known: true;
      /** The version behind the `latest` dist-tag. */
      readonly version: string;
      /** Publish time as a unix epoch in milliseconds. */
      readonly at: number;
      /** Whole days since publication. Never negative. */
      readonly ageDays: number;
    }
  | {
      readonly known: false;
      readonly reason: 'no-latest-version' | 'no-timestamp';
    };

/**
 * How many npm accounts can publish this package.
 *
 * Absent and empty are both `known: false`. A published package always has at
 * least one owner, so an empty array is a metadata artefact rather than a
 * finding, and surfacing "0 maintainers" would be a louder claim than the truth.
 */
export type MaintainerSignal =
  | { readonly known: true; readonly count: number; readonly names: readonly string[] }
  | { readonly known: false };

export interface RegistrySignals {
  readonly lastPublish: LastPublishSignal;
  readonly maintainers: MaintainerSignal;
}

const MS_PER_DAY = 86_400_000;

// --- Pure parsing ------------------------------------------------------------

/**
 * Derives risk signals from a registry document.
 *
 * `now` is injected rather than read from the clock so that age is a function
 * of its inputs and the tests do not rot as the calendar moves.
 */
export function parseRegistrySignals(
  doc: RegistryDocument,
  { now }: { readonly now: number },
): RegistrySignals {
  return {
    lastPublish: readLastPublish(doc, now),
    maintainers: readMaintainers(doc),
  };
}

function readLastPublish(doc: RegistryDocument, now: number): LastPublishSignal {
  const version = doc['dist-tags']?.latest;
  if (version === undefined) return { known: false, reason: 'no-latest-version' };

  // Deliberately the timestamp of the latest *version*, not `time.modified`.
  // `modified` also moves for deprecations and ownership edits, which would make
  // a dormant package look actively maintained.
  const raw = doc.time?.[version];
  if (raw === undefined) return { known: false, reason: 'no-timestamp' };

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return { known: false, reason: 'no-timestamp' };

  // Clamped at zero: registry/client clock skew should not yield a negative age
  // that a scoring model would then read as "extraordinarily fresh".
  const ageDays = Math.max(0, Math.floor((now - at) / MS_PER_DAY));

  return { known: true, version, at, ageDays };
}

function readMaintainers(doc: RegistryDocument): MaintainerSignal {
  const entries = doc.maintainers;
  if (entries === undefined || entries.length === 0) return { known: false };

  const names = entries
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);

  if (names.length === 0) return { known: false };

  return { known: true, count: names.length, names };
}

// --- Network adapter ---------------------------------------------------------

export interface RegistrySignalsClient {
  /** Resolves to null when the package does not exist. */
  fetchSignals(packageName: string): Promise<RegistrySignals | null>;
}

export function createNpmRegistrySignalsClient(
  options: {
    readonly registryUrl?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
  } = {},
): RegistrySignalsClient {
  const base = (options.registryUrl ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  return {
    async fetchSignals(packageName) {
      // Only the slash of a scoped name is encoded; the leading `@` is left as
      // is, matching how the registry addresses scoped packages.
      const res = await doFetch(`${base}/${packageName.replace('/', '%2F')}`, {
        headers: { accept: 'application/json' },
      });

      if (res.status === 404) return null;
      // A non-OK response means we do not know. Degrading to "signals absent"
      // would let a registry outage read as a clean result.
      if (!res.ok) throw new Error(`registry responded ${res.status}`);

      const body = (await res.json()) as RegistryDocument;
      return parseRegistrySignals(body, { now: now() });
    },
  };
}
