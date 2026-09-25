import type { Context, Next } from "hono";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface ThrottleOptions {
  readonly capacity?: number;
  readonly refillPerSecond?: number;
  readonly defaultCost?: number;
  readonly maxClients?: number;
}

const COSTS: readonly { readonly prefix: string; readonly cost: number }[] = [
  { prefix: "/api/mirror/build", cost: 40 },
  { prefix: "/api/copy/build", cost: 40 },
  { prefix: "/api/exit/build", cost: 40 },
  { prefix: "/api/submit", cost: 10 },
  { prefix: "/api/simulate", cost: 6 },
  { prefix: "/api/confirm", cost: 2 },
  { prefix: "/api/mirror/plan", cost: 20 },
  { prefix: "/api/exit/plan", cost: 20 },
  { prefix: "/api/copy/preview", cost: 8 },
  { prefix: "/api/portfolio", cost: 4 },
  { prefix: "/api/cash", cost: 2 },
  { prefix: "/api/history", cost: 1 },
  { prefix: "/api/trades/record", cost: 6 },
  { prefix: "/api/trades", cost: 1 },
  { prefix: "/api/traders", cost: 2 },
  { prefix: "/api/price-truth", cost: 2 },
  { prefix: "/api/assets", cost: 2 },
  { prefix: "/api/market", cost: 1 },
  { prefix: "/api/indexes", cost: 1 },
  { prefix: "/api/strategies", cost: 1 },
  { prefix: "/api/leaderboard", cost: 1 },
  { prefix: "/api/session", cost: 4 },
  { prefix: "/api/profile/avatar", cost: 6 },
  { prefix: "/api/avatars", cost: 1 },
  { prefix: "/api/profile", cost: 1 },
  { prefix: "/api/follows", cost: 2 },
  { prefix: "/api/handles", cost: 1 },
  { prefix: "/api/feed", cost: 1 },
  { prefix: "/health", cost: 0 },
];

function costOf(path: string, fallback: number): number {
  for (const rule of COSTS) if (path.startsWith(rule.prefix)) return rule.cost;
  return fallback;
}

/**
 * The caller's bucket key: the socket address, or the forwarded client address
 * when TRUST_PROXY=1. Forwarded headers are otherwise ignored, since trusting
 * them lets a caller choose its own bucket.
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

function peerAddress(c: Context): string {
  const server = c.env as { requestIP?: (request: Request) => { address?: string } | null };
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Middleware that charges each request its route's cost and answers 429 when the client's bucket is empty. */
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

    // Bound the map by evicting clients, never by letting a request through
    // unmetered.
    if (!buckets.has(key) && buckets.size >= maxClients) {
      for (const [existing, bucket] of buckets) {
        if (now - bucket.lastRefill > 60_000) buckets.delete(existing);
      }
      while (buckets.size >= maxClients) {
        const oldest = buckets.keys().next();
        if (oldest.done) break;
        buckets.delete(oldest.value);
      }
    }

    const bucket = buckets.get(key) ?? { tokens: capacity, lastRefill: now };
    // Delete and re-insert so the Map's insertion order tracks recency for the
    // eviction above.
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
