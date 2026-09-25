/**
 * Trader routes. Every figure comes from indexed on-chain trades, never from
 * the trader, and covers only trades seen since indexing began.
 */

import { Hono } from "hono";
import {
  ALL_MINTS,
  believableCost,
  computeTraderPnl,
  sectorExposure,
  symbolBooks,
  type TradeRecord,
} from "@ps/core";
import { WSOL_MINT, fetchTrades, getMintStates, type Trade } from "@ps/chain";
import type { Services } from "../context.ts";
import { BadRequest, readJson, requireBase58Address, requireInt } from "../lib/validate.ts";
import { tradeRows, type MarketSnapshot } from "@ps/market";

/** More than any bundle this app builds, and small enough not to be a relay. */
const MAX_RECORD = 20;
/**
 * How many times to look for a transaction the node does not have yet: the app
 * reports a trade once one node confirms it, and this node can lag by a second or two.
 */
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_MS = 1_500;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

/** How many of a wallet's newest trades the per-company books are drawn from. */
const BOOK_TRADES = 2_000;

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
   * A trader's record. Positions are reconstructed from indexed trades rather
   * than read from chain, so profit is only attached to shares with a known cost.
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

    // Everything seen, for the per-company books; the window, for the record.
    const everything = services.store.tradesFor(owner, BOOK_TRADES);
    // Past the cap the oldest trades are missing, so no book is complete.
    const capped = everything.length >= BOOK_TRADES;
    const trades = everything.filter((t) => t.slot >= sinceSlot).slice(0, 500);
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

    // Allocation weights over long positions only: a short is an artefact of
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
      /**
       * Per company, over every trade seen rather than the window: cash in and
       * out, and whether that record is complete.
       */
      books: symbolBooks(everything, prices).map((book) => ({
        ...book,
        complete: book.complete && !capped,
        firstAt: book.firstAt === null ? null : new Date(book.firstAt * 1000).toISOString(),
        lastAt: book.lastAt === null ? null : new Date(book.lastAt * 1000).toISOString(),
      })),
      caveats: [
        "Only trades made since we started watching the market are counted; anything earlier is invisible.",
        "What the wallet still holds is valued at today's market price.",
        pnl.coverageComplete
          ? "Every trade in this window had a visible price."
          : "Some trades had no visible price, so the profit figure is rough.",
      ],
    });
  });

  /**
   * The newest trades across every wallet, for the live feed. Trades whose
   * recorded cost is implausible for their size (another leg's stablecoin) are dropped.
   */
  app.get("/api/trades/recent", async (c) => {
    const limit = requireInt(c.req.query("limit"), "limit", { min: 1, max: 50, fallback: 12 });
    // Lets the dashboard leave out dust fills.
    const minUsd = requireInt(c.req.query("minUsd"), "minUsd", { min: 0, max: 1_000_000, fallback: 0 });
    const snapshot = await market();
    const prices = priceMap(snapshot);
    const trades = services.store
      .recentTrades(minUsd > 0 ? 400 : limit * 4)
      .filter((t) => Math.abs(t.valueUsd ?? 0) >= minUsd)
      .filter((t) => believableCost(t, prices.get(t.symbol)))
      .slice(0, limit)
      .map((t) => ({
        signature: t.signature,
        owner: t.owner,
        symbol: t.symbol,
        side: t.uiAmount > 0 ? "buy" : "sell",
        uiAmount: Math.abs(t.uiAmount),
        valueUsd: Math.abs(t.valueUsd ?? 0),
        blockTime: t.blockTime,
      }));
    return c.json({ asOf: snapshot.takenAt.toISOString(), trades });
  });

  /**
   * Trades by the wallets someone follows, newest first, with the same cost
   * check as the market feed. Follows are public, so no sign-in is needed.
   */
  app.get("/api/feed/:wallet", async (c) => {
    const follower = requireBase58Address(c.req.param("wallet"), "wallet");
    const limit = requireInt(c.req.query("limit"), "limit", { min: 1, max: 100, fallback: 30 });
    const snapshot = await market();
    const prices = priceMap(snapshot);
    const trades = services.store
      .followedTrades(follower, limit * 3)
      .filter((t) => believableCost(t, prices.get(t.symbol)))
      .slice(0, limit);
    const names = services.store.profiles(trades.map((t) => t.owner));
    const avatars = services.store.avatars(trades.map((t) => t.owner));
    return c.json({
      wallet: follower,
      trades: trades.map((t) => ({
        signature: t.signature,
        owner: t.owner,
        name: names.get(t.owner)?.name || null,
        handle: names.get(t.owner)?.handle ?? null,
        avatar: avatars.get(t.owner) ?? null,
        symbol: t.symbol,
        side: t.uiAmount > 0 ? "buy" : "sell",
        uiAmount: Math.abs(t.uiAmount),
        valueUsd: Math.abs(t.valueUsd ?? 0),
        blockTime: t.blockTime,
      })),
    });
  });

  /**
   * Record this app's trades as they land, ahead of the indexer's next pass.
   * Each signature is read back from chain, and rows are keyed by signature,
   * so the indexer finding the same trade later changes nothing.
   */
  app.post("/api/trades/record", async (c) => {
    const body = await readJson(c);
    const raw = body["signatures"];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RECORD) {
      throw new BadRequest(`signatures must be a list of 1 to ${MAX_RECORD} transaction signatures`);
    }
    for (const value of raw) {
      if (typeof value !== "string" || !SIGNATURE.test(value)) throw new BadRequest("not a transaction signature");
    }
    let pending = [...new Set(raw as string[])];
    const watched = new Set(ALL_MINTS);
    const trades: Trade[] = [];
    for (let attempt = 0; attempt < RECORD_ATTEMPTS && pending.length > 0; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_MS));
      const found = await fetchTrades(services.rpc, pending, watched, { batchSize: 1, commitment: "confirmed" });
      trades.push(...found.trades);
      const seen = new Set(found.seen);
      pending = pending.filter((signature) => !seen.has(signature));
    }

    let recorded = 0;
    if (trades.length > 0) {
      const mintStates = await getMintStates(services.rpc, ALL_MINTS);
      // SOL is priced only for a trade that has no stablecoin leg; the app's
      // own trades always have one.
      const needsSol = trades.some((t) => t.usdcDeltaRaw === null || t.usdcDeltaRaw === 0n);
      const solUsd = needsSol
        ? await services.jupiter
            .prices([WSOL_MINT])
            .then((prices) => prices[WSOL_MINT]?.usdPrice ?? null)
            .catch(() => null)
        : null;
      recorded = services.store.writeTrades(tradeRows(trades, mintStates, Math.floor(Date.now() / 1000), solUsd));
    }
    return c.json({ recorded, trades: trades.length, notFound: pending.length });
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
 * Win rate over closed round trips: a symbol's position closes when its running
 * quantity returns to zero, and wins if more cash came out than went in.
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
