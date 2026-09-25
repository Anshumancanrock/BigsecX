import type { Hono } from "hono";
import { buildLeaderboard, type TradeRecord } from "@ps/core";
import { Cache, type MarketSnapshot } from "@ps/market";
import { getSellableBalances } from "@ps/tx";
import type { Services } from "../context.ts";
import { mapLimit, slots } from "../lib/concurrency.ts";
import type { SnapshotReader } from "../lib/market-cache.ts";
import { priceMaps } from "../lib/snapshot.ts";
import { requireInt } from "../lib/validate.ts";

/** Mainnet produces a slot roughly every 0.4 s. */
const SECONDS_PER_SLOT = 0.4;
const HELD_TTL_MS = 3 * 60_000;
/**
 * Past the TTL a wallet's last known balances are served while fresh ones are
 * read. A stale balance only decides whether a row is shown, and the next
 * read corrects it; without this a cold board waits on a hundred chain reads.
 */
const HELD_STALE_MS = 6 * 60 * 60_000;
/** A wallet still holds a position when it keeps at least this share of it. */
const STILL_HELD_FRACTION = 0.1;

/**
 * Traders ranked by profit against the cost basis observed on chain, not by
 * change in portfolio value, which would reward funding a wallet rather than
 * trading it. The limits of that reconstruction are returned as caveats.
 */
export function registerLeaderboardRoutes(app: Hono, services: Services, market: SnapshotReader): void {
  const heldBy = liveHoldings(services);

  app.get("/api/leaderboard", async (c) => {
    const hours = requireInt(c.req.query("hours"), "hours", { min: 1, max: 24 * 30, fallback: 24 });
    const limit = requireInt(c.req.query("limit"), "limit", { min: 1, max: 100, fallback: 25 });
    const sortBy = ((): "pnl" | "return" | "volume" => {
      const raw = c.req.query("sortBy");
      return raw === "return" || raw === "volume" ? raw : "pnl";
    })();

    const latestSlot = services.store.latestTradeSlot();
    if (latestSlot === null) {
      return c.json({ window: `${hours}h`, entries: [], note: "no trades indexed yet" });
    }

    // Windowed by slot rather than block time, which can be null for older rows.
    const sinceSlot = Math.max(0, latestSlot - Math.round((hours * 3_600) / SECONDS_PER_SLOT));
    const byOwner = services.store.tradesByOwnerSince(sinceSlot);

    const snapshot = await market();
    const prices = new Map<string, number>();
    for (const t of snapshot.tokens) {
      if (t.marketUsd !== null) prices.set(t.token.symbol, t.marketUsd);
    }

    const records = new Map<string, TradeRecord[]>();
    for (const [owner, trades] of byOwner) {
      records.set(
        owner,
        trades.map((t) => ({
          owner,
          symbol: t.symbol,
          uiAmount: t.uiAmount,
          valueUsd: t.valueUsd,
          slot: t.slot,
        })),
      );
    }

    // Adjustable because the right floor depends on how much history is indexed.
    const minVolumeUsd = requireInt(c.req.query("minVolumeUsd"), "minVolumeUsd", {
      min: 0,
      max: 1_000_000,
      fallback: 100,
    });
    // Ranked with room to spare, because keepStillHeld drops some rows.
    const ranked = buildLeaderboard(records, prices, { limit: Math.min(100, limit * 2), sortBy, minVolumeUsd });
    const board = await keepStillHeld(ranked, (owner) => heldBy(owner, snapshot), limit);
    const names = services.store.profiles(board.map((row) => row.owner));
    const avatars = services.store.avatars(board.map((row) => row.owner));

    return c.json({
      window: `${hours}h`,
      sortBy,
      minVolumeUsd,
      sinceSlot,
      walletsConsidered: records.size,
      entries: board.map((row) => ({
        owner: row.owner,
        trades: row.trades,
        volumeUsd: row.volumeUsd,
        peakInvestedUsd: row.peakInvestedUsd,
        markValueUsd: row.markValueUsd,
        pnlUsd: row.pnlUsd,
        returnFraction: row.returnFraction,
        positions: row.positions,
        held: row.held,
        name: names.get(row.owner)?.name || null,
        handle: names.get(row.owner)?.handle ?? null,
        avatar: avatars.get(row.owner) ?? null,
      })),
      caveats: [
        "Profit only counts trades made since we started watching the market.",
        "A wallet that sold something it bought before then is left out, because we do not know what it paid.",
        "What a wallet still holds is valued at today's market price.",
        "A wallet that no longer holds the position we saw it build is left out: it sold or moved it where we could not see, so its profit is unknown.",
      ],
    });
  });
}

/**
 * Live holdings per wallet, from the associated token accounts a copy would
 * buy into. Cached because the board is read far more often than these
 * wallets trade.
 */
function liveHoldings(services: Services) {
  const cache = new Cache(1_000);
  // Background refreshes are fire-and-forget, so the RPC reads are gated here:
  // at most four at once against the endpoint the builds also depend on.
  const reads = slots(4);
  return (owner: string, snapshot: MarketSnapshot): Promise<Map<string, number>> =>
    cache.fetch(
      `held:${owner}`,
      HELD_TTL_MS,
      () =>
        reads(async () => {
          const balances = await getSellableBalances(
            services.rpc,
            owner,
            priceMaps(snapshot).scaleConfig,
            snapshot.unixSeconds,
          );
          return new Map([...balances.values()].map((b) => [b.symbol, b.uiAmount]));
        }),
      HELD_STALE_MS,
      { revalidateInBackground: true },
    );
}

/**
 * Drops rows whose positions have left the wallet by a transfer or a swap
 * the indexer did not see. Their profit is unknown, the same as a wallet
 * whose cost basis is unknown.
 *
 * A wallet that closed everything through indexed trades has a realised,
 * known profit and stays; so does one whose balances cannot be read.
 */
async function keepStillHeld<T extends { owner: string; positions: readonly { symbol: string; uiAmount: number }[] }>(
  rows: readonly T[],
  heldBy: (owner: string) => Promise<Map<string, number>>,
  limit: number,
): Promise<(T & { held: string[] | null })[]> {
  const checked = await mapLimit(rows, 4, async (row) => {
    const open = row.positions.filter((p) => p.uiAmount > 1e-9);
    let live: Map<string, number>;
    try {
      live = await heldBy(row.owner);
    } catch {
      return { ...row, held: null, keep: true };
    }
    const held = [...live].filter(([, amount]) => amount > 1e-9).map(([symbol]) => symbol);
    const keep =
      open.length === 0 || open.some((p) => (live.get(p.symbol) ?? 0) >= p.uiAmount * STILL_HELD_FRACTION);
    return { ...row, held, keep };
  });
  return checked
    .filter((row) => row.keep)
    .slice(0, limit)
    .map(({ keep: _keep, ...row }) => row as T & { held: string[] | null });
}
