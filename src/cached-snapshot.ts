/**
 * Every reader that polls something slow — the Orca runtime, `ps`, nginx configs, pm2 — repeats
 * the same four moving parts: a TTL, in-flight de-duplication so a burst of requests causes one
 * scan, a version that only advances when the content actually changed, and a last-known value
 * to serve while nothing has been loaded yet.
 *
 * The version is the contract with HTTP callers: it feeds the ETag, so bumping it on an unchanged
 * snapshot costs a needless payload, and failing to bump it on a changed one strands the client.
 * Both mistakes were easy to make when each reader spelled this out for itself.
 */

export interface CachedSnapshotOptions<Input, T> {
  ttlMs: number;
  load(input: Input, startedAt: number): Promise<T>;
  /**
   * Version advances only when this changes. Defaults to a JSON signature, which is right for
   * plain snapshots and wrong for anything holding a Map or a Date — pass your own for those.
   */
  signature?(value: T): string;
  /** Readers whose result depends on their input serve a different slot per key. */
  cacheKey?(input: Input): string;
  now?(): number;
}

export interface CachedSnapshot<Input, T> {
  /** Loads at most once per TTL per cache key; concurrent callers share the in-flight load. */
  refresh(input: Input): Promise<T>;
  /** Last loaded value, without triggering a load. Null until the first load resolves. */
  peek(): T | null;
  getVersion(): number;
}

const SINGLE_SLOT = "";

export function createCachedSnapshot<Input = void, T = unknown>(
  options: CachedSnapshotOptions<Input, T>,
): CachedSnapshot<Input, T> {
  const now = options.now ?? Date.now;
  const signatureOf = options.signature ?? ((value: T) => JSON.stringify(value));
  const keyOf = options.cacheKey ?? (() => SINGLE_SLOT);
  let cached: T | null = null;
  let cachedAt = Number.NEGATIVE_INFINITY;
  let cachedKey = SINGLE_SLOT;
  let pending: Promise<T> | null = null;
  let version = 0;
  let signature: string | null = null;

  async function load(input: Input, startedAt: number): Promise<T> {
    const value = await options.load(input, startedAt);
    const next = signatureOf(value);
    if (next !== signature) {
      signature = next;
      version += 1;
    }
    cached = value;
    cachedAt = startedAt;
    return value;
  }

  return {
    refresh: (input) => {
      const key = keyOf(input);
      const current = now();
      // A key change invalidates the slot outright: the cached value answers a different question.
      if (cached !== null && key === cachedKey && current - cachedAt < options.ttlMs) {
        return Promise.resolve(cached);
      }
      if (pending !== null && key === cachedKey) return pending;
      cachedKey = key;
      pending = load(input, current).finally(() => { pending = null; });
      return pending;
    },
    peek: () => cached,
    getVersion: () => version,
  };
}
