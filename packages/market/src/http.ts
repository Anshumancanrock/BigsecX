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

  /** Age of a cached value in milliseconds, or null if absent. */
  ageMs(key: string, ttlMs: number): number | null {
    const entry = this.#entries.get(key);
    return entry ? Date.now() - (entry.expiresAt - ttlMs) : null;
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
  },
): Promise<T> {
  const maxRetries = options.maxRetries ?? 4;

  let lastStatus: number | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Upstream 429s here are sustained, not bursty, so back off generously.
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** (attempt - 1)));
    }
    await options.limiter?.acquire();

    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
    });

    if (response.ok) return (await response.json()) as T;
    lastStatus = response.status;
    if (response.status !== 429 && response.status < 500) {
      throw new UpstreamError(options.upstream, response.status, `HTTP ${response.status}`);
    }
  }
  throw new UpstreamError(
    options.upstream,
    lastStatus,
    `gave up after ${maxRetries} retries (last status ${lastStatus})`,
  );
}
