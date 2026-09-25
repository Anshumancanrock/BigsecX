/**
 * HTTP plumbing for upstream market data. The upstreams rate limit tightly
 * (prestocks.com returns 429 under light polling), so every call goes through a
 * token bucket and concurrent cache misses share a single request.
 */

/** Token bucket that refills continuously rather than in fixed windows. */
export class RateLimiter {
  #tokens: number;
  #lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.#tokens = capacity;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.#tokens) / this.refillPerSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 25)));
    }
  }

  #refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.#lastRefill) / 1000;
    this.#lastRefill = now;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsedSeconds * this.refillPerSecond);
  }
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  /** Kept past expiry so a failing upstream can be served stale. */
  staleUntil: number;
}

/**
 * Cache with single-flight loading and stale-on-error, so a failing upstream
 * degrades to a slightly old value instead of an error. With
 * `revalidateInBackground`, an expired value is returned at once and reloaded
 * behind it, so the first caller after expiry does not wait on the upstream.
 */
export class Cache {
  readonly #entries = new Map<string, CacheEntry<unknown>>();
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #maxEntries: number;

  /**
   * @param maxEntries Bound on retained entries. Quote keys embed the trade
   * amount, so the key space is unbounded, and expiry alone never frees an entry.
   */
  constructor(maxEntries = 2_000) {
    this.#maxEntries = maxEntries;
  }

  /**
   * Evicts in insertion order until within bound. FIFO rather than LRU, which
   * is adequate for entries that expire within seconds.
   */
  #evict(): void {
    if (this.#entries.size <= this.#maxEntries) return;
    const excess = this.#entries.size - this.#maxEntries;
    let removed = 0;
    for (const key of this.#entries.keys()) {
      if (removed >= excess) break;
      // Never evict something a caller is currently waiting on.
      if (this.#inFlight.has(key)) continue;
      this.#entries.delete(key);
      removed++;
    }
  }

  async fetch<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    staleMs = ttlMs * 10,
    options: { revalidateInBackground?: boolean } = {},
  ): Promise<T> {
    const now = Date.now();
    const entry = this.#entries.get(key) as CacheEntry<T> | undefined;
    if (entry && now < entry.expiresAt) return entry.value;

    const existing = this.#inFlight.get(key) as Promise<T> | undefined;
    if (options.revalidateInBackground && entry && now < entry.staleUntil) {
      // Nobody awaits this reload; on failure the old value stays for the next caller.
      if (!existing) this.#load(key, ttlMs, staleMs, loader, entry).catch(() => undefined);
      return entry.value;
    }
    if (existing) return existing;
    return this.#load(key, ttlMs, staleMs, loader, entry);
  }

  #load<T>(
    key: string,
    ttlMs: number,
    staleMs: number,
    loader: () => Promise<T>,
    entry: CacheEntry<T> | undefined,
  ): Promise<T> {
    const promise = loader()
      .then((value) => {
        this.#entries.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
          staleUntil: Date.now() + ttlMs + staleMs,
        });
        this.#evict();
        return value;
      })
      .catch((error: unknown) => {
        if (entry && Date.now() < entry.staleUntil) return entry.value;
        throw error;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, promise);
    return promise;
  }

  /** Number of retained entries. Exposed for tests and diagnostics. */
  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}

export class UpstreamError extends Error {
  constructor(
    readonly upstream: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** GET returning JSON, retrying on 429, 5xx and transport failures. */
export async function getJson<T>(
  url: string,
  options: {
    readonly upstream: string;
    readonly limiter?: RateLimiter;
    readonly maxRetries?: number;
    readonly timeoutMs?: number;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<T> {
  const maxRetries = options.maxRetries ?? 4;

  let lastStatus: number | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Upstream 429s here are sustained, not bursty, so back off generously.
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** (attempt - 1)));
    }
    await options.limiter?.acquire();

    // Inside the try so network errors and timeouts, which reject instead of
    // returning a status, are retried too.
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", ...options.headers },
        signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
      });

      if (response.ok) return (await response.json()) as T;
      lastStatus = response.status;
      if (response.status !== 429 && response.status < 500) {
        throw new UpstreamError(options.upstream, response.status, `HTTP ${response.status}`);
      }
    } catch (error) {
      // A deliberate refusal is final; a transport failure is worth retrying.
      if (error instanceof UpstreamError) throw error;
      lastError = error as Error;
    }
  }
  throw new UpstreamError(
    options.upstream,
    lastStatus,
    `gave up after ${maxRetries} retries (last status ${lastStatus ?? "none"}` +
      `${lastError ? `, last error ${lastError.message}` : ""})`,
  );
}
