import { Cache, takeSnapshot, type MarketSnapshot } from "@ps/market";
import type { Services } from "../context.ts";

const MARKET_TTL_MS = 3_000;
const MARKET_STALE_MS = 10 * 60_000;

export type SnapshotReader = () => Promise<MarketSnapshot>;

/**
 * The two views of the market snapshot. They share one cache, so concurrent
 * requests collapse into a single upstream read, and an upstream 429 serves
 * the last good snapshot instead of failing.
 */
export function marketCache(services: Services): { market: SnapshotReader; tradingMarket: SnapshotReader } {
  const cache = new Cache(4);
  const take = () => takeSnapshot(services.rpc, services.jupiter);
  return {
    market: () => cache.fetch("snapshot", MARKET_TTL_MS, take, MARKET_STALE_MS, { revalidateInBackground: true }),
    // Builds: pause flags, share multipliers and the clock must be current, so
    // past the TTL this waits for a fresh snapshot and falls back to the stale
    // one only when every upstream is failing.
    tradingMarket: () => cache.fetch("snapshot", MARKET_TTL_MS, take, MARKET_STALE_MS),
  };
}
