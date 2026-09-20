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
 * Behind a proxy the socket address is the proxy, so the forwarded header is
 * preferred when present. It is spoofable, which matters for a public
 * deployment but not for the thing this defends against: an unthrottled
 * client exhausting the upstream quota by accident or impatience.
 */
function clientKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return c.req.header("x-real-ip") ?? "unknown";
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

    // Bound the map. Without this the limiter is itself a memory leak, since
    // every distinct client address would be retained forever.
    if (!buckets.has(key) && buckets.size >= maxClients) {
      for (const [existing, bucket] of buckets) {
        if (now - bucket.lastRefill > 60_000) buckets.delete(existing);
      }
      // Still full of active clients: let the request through rather than
      // refusing traffic because of our own bookkeeping.
      if (buckets.size >= maxClients) return next();
    }

    const bucket = buckets.get(key) ?? { tokens: capacity, lastRefill: now };
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
