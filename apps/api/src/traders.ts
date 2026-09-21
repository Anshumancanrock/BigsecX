/**
 * Trader routes: a wallet's verified record.
 *
 * Everything here is derived from indexed on-chain activity. Nobody reports
 * their own performance, which is the only way a leaderboard is worth
 * reading -- and it is also why the numbers carry explicit limits: we can
 * only account for trades seen since indexing began.
 */

import { Hono } from "hono";
import { computeTraderPnl, sectorExposure, type TradeRecord } from "@ps/core";
import type { Services } from "./context.ts";
import { requireBase58Address, requireInt } from "./validate.ts";
import type { MarketSnapshot } from "@ps/market";

/** Solana produces roughly one slot every 400ms. */
const SLOTS_PER_HOUR = 3_600 / 0.4;

function priceMap(snapshot: MarketSnapshot): Map<string, number> {
  return new Map(
    snapshot.tokens.flatMap((t) =>
      t.marketUsd === null ? [] : [[t.token.symbol, t.marketUsd] as const],
    ),
  );
}

export function registerTraderRoutes(
  app: Hono,
  services: Services,
  market: () => Promise<MarketSnapshot>,
): void {
  /**
   * A trader's profile: the numbers behind a strategy card.
   *
   * Positions here are reconstructed from indexed trades, not read from the
   * chain. That is deliberate: this view answers "what did this wallet do
   * that we can account for", and mixing in balances we never saw traded
   * would attach profit to shares whose cost is unknown.
   */
  app.get("/api/traders/:wallet", async (c) => {
    const owner = requireBase58Address(c.req.param("wallet"), "wallet");
    const hours = requireInt(c.req.query("hours"), "hours", {
      min: 1,
      max: 24 * 365,
      fallback: 24 * 30,
    });

    const latestSlot = services.store.latestTradeSlot();
    const sinceSlot = latestSlot === null ? 0 : Math.max(0, latestSlot - Math.round(hours * SLOTS_PER_HOUR));

    const trades = services.store.tradesFor(owner, 500).filter((t) => t.slot >= sinceSlot);
    const snapshot = await market();
    const prices = priceMap(snapshot);

    const records: TradeRecord[] = trades.map((t) => ({
      owner,
      symbol: t.symbol,
      uiAmount: t.uiAmount,
      valueUsd: t.valueUsd,
      slot: t.slot,
    }));
    const pnl = computeTraderPnl(owner, records, prices);

    // Weights over the reconstructed position, for the allocation bar on a
    // strategy card. Short positions are excluded: they are an artefact of
    // incomplete cost basis, not an allocation.
    const longs = pnl.positions.filter((p) => p.uiAmount > 0);
    const valued = longs.map((p) => ({ ...p, usd: p.uiAmount * (prices.get(p.symbol) ?? 0) }));
    const totalUsd = valued.reduce((sum, p) => sum + p.usd, 0);
    const weights = totalUsd > 0 ? valued.map((p) => ({ symbol: p.symbol, weight: p.usd / totalUsd })) : [];

    const wins = countWins(trades);

    return c.json({
      owner,
      window: `${hours}h`,
      asOf: snapshot.takenAt.toISOString(),
      trades: pnl.trades,
      volumeUsd: pnl.volumeUsd,
      peakInvestedUsd: pnl.peakInvestedUsd,
      markValueUsd: pnl.markValueUsd,
      pnlUsd: pnl.pnlUsd,
      returnFraction: pnl.returnFraction,
      /** False when the record is incomplete and the profit figure is unreliable. */
      coverageComplete: pnl.coverageComplete,
      positions: pnl.positions,
      weights,
      sectors: Object.fromEntries(sectorExposure(weights)),
      closedTrades: wins.closed,
      winRate: wins.rate,
      caveats: [
        "Reconstructed from trades indexed since this deployment started watching; earlier activity is invisible.",
        "Open positions are marked at the current DEX price, not at any price this wallet was filled at.",
        pnl.coverageComplete
          ? "Every trade in this window had an observable cost."
          : "Some trades had no observable cost, so the profit figure is unreliable.",
      ],
    });
  });

  /** Raw trade history, newest first. */
  app.get("/api/traders/:wallet/trades", (c) => {
    const owner = requireBase58Address(c.req.param("wallet"), "wallet");
    const limit = requireInt(c.req.query("limit"), "limit", { min: 1, max: 500, fallback: 100 });

    const trades = services.store.tradesFor(owner, limit);
    return c.json({
      owner,
      trades: trades.map((t) => ({
        signature: t.signature,
        symbol: t.symbol,
        side: t.uiAmount > 0 ? "buy" : "sell",
        uiAmount: Math.abs(t.uiAmount),
        valueUsd: t.valueUsd === null ? null : Math.abs(t.valueUsd),
        slot: t.slot,
        at: t.blockTime === null ? null : new Date(t.blockTime * 1000).toISOString(),
      })),
    });
  });
}

/**
 * Win rate over closed round trips.
 *
 * Counted per symbol: a position is closed when its running quantity returns
 * to zero, and the round trip wins if the cash taken out exceeded the cash
 * put in. Counting individual trades instead would call every sell a win.
 */
function countWins(
  trades: readonly { symbol: string; uiAmount: number; valueUsd: number | null; slot: number }[],
): { readonly closed: number; readonly rate: number | null } {
  const open = new Map<string, { quantity: number; cash: number }>();
  let closed = 0;
  let won = 0;

  for (const trade of [...trades].sort((a, b) => a.slot - b.slot)) {
    const state = open.get(trade.symbol) ?? { quantity: 0, cash: 0 };
    state.quantity += trade.uiAmount;
    state.cash += trade.valueUsd ?? 0;

    // Back to flat, within a nanoshare of rounding.
    if (Math.abs(state.quantity) < 1e-9) {
      closed++;
      // Positive cash means more was spent than recovered: a loss.
      if (state.cash < 0) won++;
      open.delete(trade.symbol);
    } else {
      open.set(trade.symbol, state);
    }
  }
  return { closed, rate: closed > 0 ? won / closed : null };
}
