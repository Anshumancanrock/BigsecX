/**
 * Shared HTTP plumbing for upstream market data.
 *
 * Both upstreams we depend on are strict about request volume, and we found out
 * the hard way: prestocks.com/api/prestocks returns 429 under light polling,
 * and lite-api.jup.ag advertises a remaining quota in single digits
 * (`x-ratelimit-remaining: 4`). So every outbound call goes through a token
 * bucket, and every cache miss is single-flighted -- fifty concurrent page
 * loads must produce one upstream request, not fifty.
 */

/** Simple token bucket. Refills continuously rather than in fixed windows. */
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
 * Cache with single-flight and stale-on-error.
 *
 * Stale-on-error matters more than it looks: the issuer API is the only source
 * of mark prices, and a 429 during a demo should degrade to a slightly old
 * number with a visible timestamp, not to an empty screen.
 */
export class Cache {
  readonly #entries = new Map<string, CacheEntry<unknown>>();
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #maxEntries: number;

  /**
   * @param maxEntries Bound on retained entries. Quote keys embed the trade
   * amount, so an API serving arbitrary sizes mints a new key per request and
   * an unbounded map would retain every one of them for the life of the
   * process -- expired entries included, since expiry only triggers a refetch
   * and never reclaims anything.
   */
  constructor(maxEntries = 2_000) {
    this.#maxEntries = maxEntries;
  }

  /**
   * Evict oldest-first until the map is back within its bound.
   *
   * Map iterates in insertion order, so this is a first-in-first-out policy
   * rather than a true LRU. For a cache whose entries expire in seconds the
   * difference does not matter, and it avoids tracking access times.
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
  ): Promise<T> {
    const now = Date.now();
    const entry = this.#entries.get(key) as CacheEntry<T> | undefined;
    if (entry && now < entry.expiresAt) return entry.value;

    const existing = this.#inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

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

/** GET returning JSON, with retry on 429 and 5xx. */
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

    // The fetch has to sit inside the try. A dropped connection, a DNS
    // failure or a timeout rejects rather than returning a status, and
    // outside a catch that rejection escapes the retry loop entirely --
    // making maxRetries cover only HTTP statuses, which is not where flaky
    // conference wifi fails.
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
