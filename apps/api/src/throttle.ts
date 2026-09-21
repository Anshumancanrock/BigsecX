/**
 * Inbound rate limiting.
 *
 * Every quote and instruction build spends the deployment's upstream budget,
 * and that budget is small: the keyless Jupiter tier reports a remaining
 * quota in single digits while one eight-leg basket needs sixteen calls. An
 * unauthenticated build endpoint with no throttle is therefore not merely a
 * denial of service against us, it is a way for anyone to exhaust the quota
 * the demo runs on.
 *
 * Costs differ by orders of magnitude, so requests are weighted rather than
 * counted: a cached market read is nearly free, a build is not.
 */

import type { Context, Next } from "hono";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface ThrottleOptions {
  /** Burst capacity, in cost units. */
  readonly capacity?: number;
  /** Sustained refill, in cost units per second. */
  readonly refillPerSecond?: number;
  /** Cost of a request whose path matches none of the rules. */
  readonly defaultCost?: number;
  readonly maxClients?: number;
}

/** What each route costs, by path prefix, most specific first. */
const COSTS: readonly { readonly prefix: string; readonly cost: number }[] = [
  // Builds quote every leg and then fetch instructions for each.
  { prefix: "/api/mirror/build", cost: 40 },
  { prefix: "/api/copy/build", cost: 40 },
  // Plans quote every leg.
  { prefix: "/api/mirror/plan", cost: 20 },
  { prefix: "/api/copy/preview", cost: 8 },
  // Chain reads, but no aggregator traffic.
  { prefix: "/api/portfolio", cost: 4 },
  { prefix: "/api/traders", cost: 2 },
  { prefix: "/api/price-truth", cost: 2 },
  // Served from cache or the local database.
  { prefix: "/api/assets", cost: 2 },
  { prefix: "/api/market", cost: 1 },
  { prefix: "/api/indexes", cost: 1 },
  { prefix: "/api/strategies", cost: 1 },
  { prefix: "/api/leaderboard", cost: 1 },
  { prefix: "/health", cost: 0 },
];

function costOf(path: string, fallback: number): number {
  for (const rule of COSTS) if (path.startsWith(rule.prefix)) return rule.cost;
  return fallback;
}

/**
 * Identify the caller.
 *
 * The socket address is the fallback and the default. Trusting a forwarded
 * header unconditionally lets any caller pick its own bucket, and falling
 * back to a constant is worse still: with no proxy in front -- which is how
 * this runs locally and during a demo -- every client shared one bucket, so
 * the fourth independent visitor was refused because of the first three.
 *
 * Forwarded headers are honoured only behind TRUST_PROXY=1, which is a
 * deployment fact the deployment states rather than something a request
 * asserts about itself.
 */
function clientKey(c: Context): string {
  if (process.env["TRUST_PROXY"] === "1") {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]?.trim() ?? peerAddress(c);
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }
  return peerAddress(c);
}

/**
 * The peer's socket address.
 *
 * Under Bun's `export default { fetch }` binding, Hono's `c.env` IS the
 * Server object, so `requestIP` is reached directly on it rather than
 * through a wrapper.
 */
function peerAddress(c: Context): string {
  const server = c.env as { requestIP?: (request: Request) => { address?: string } | null };
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function throttle(options: ThrottleOptions = {}) {
  const capacity = options.capacity ?? 120;
  const refillPerSecond = options.refillPerSecond ?? 20;
  const defaultCost = options.defaultCost ?? 4;
  const maxClients = options.maxClients ?? 5_000;

  const buckets = new Map<string, Bucket>();

  return async (c: Context, next: Next) => {
    const cost = costOf(c.req.path, defaultCost);
    if (cost === 0) return next();

    const key = clientKey(c);
    const now = Date.now();

    // Bound the map, without ever letting a request through unmetered.
    // Failing open under pressure hands an attacker the bypass: fill the map
    // with distinct addresses and every subsequent request is free.
    if (!buckets.has(key) && buckets.size >= maxClients) {
      for (const [existing, bucket] of buckets) {
        if (now - bucket.lastRefill > 60_000) buckets.delete(existing);
      }
      // Still full of active clients: evict the least recently seen.
      while (buckets.size >= maxClients) {
        const oldest = buckets.keys().next();
        if (oldest.done) break;
        buckets.delete(oldest.value);
      }
    }

    const bucket = buckets.get(key) ?? { tokens: capacity, lastRefill: now };
    // Map preserves insertion order and set() on an existing key keeps its
    // original position, so the hot path deletes first to make order mean
    // recency for the eviction above.
    buckets.delete(key);
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + ((now - bucket.lastRefill) / 1000) * refillPerSecond,
    );
    bucket.lastRefill = now;

    if (bucket.tokens < cost) {
      const waitSeconds = Math.ceil((cost - bucket.tokens) / refillPerSecond);
      buckets.set(key, bucket);
      c.header("retry-after", String(waitSeconds));
      return c.json(
        {
          error: "too many requests",
          detail:
            "This endpoint spends a shared upstream quota. Retry after the interval given in the retry-after header.",
          retryAfterSeconds: waitSeconds,
        },
        429,
      );
    }

    bucket.tokens -= cost;
    buckets.set(key, bucket);
    return next();
  };
}
