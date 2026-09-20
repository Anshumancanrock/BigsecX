/**
 * The indexing job: take a market snapshot, record it, record the largest
 * holders, and record where each index stands.
 *
 * Runs on a timer. Everything downstream -- leaderboards, index charts,
 * mirroring a trader -- reads what this writes, so it is the only component
 * that talks to both the chain and the database.
 */

import {
  INDEX_DEFINITIONS,
  buildIndex,
  byMint,
  rawToUi,
  type IndexInput,
  type Weight,
} from "@ps/core";
import { Rpc, fetchTrades, getMintStates, getSignaturesSince } from "@ps/chain";
import type { JupiterClient } from "@ps/market";
import { Store, type TradeRow } from "@ps/db";
import { takeSnapshot, type MarketSnapshot } from "./snapshot.ts";

/** Index levels start here, so a chart reads as a percentage from launch. */
const INDEX_BASE = 1_000;

export interface JobResult {
  readonly snapshotId: number;
  readonly snapshot: MarketSnapshot;
  readonly tradesWritten: number;
  readonly tradersSeen: number;
  readonly indexesWritten: number;
  /** Signatures whose fetch failed; their windows will be retried. */
  readonly missedSignatures: number;
  /** Set when trade indexing failed but the snapshot still succeeded. */
  readonly tradeError: string | null;
}

/** Signatures pulled per mint per pass. */
const SIGNATURES_PER_MINT = Number(process.env["SIGNATURES_PER_MINT"] ?? 15);

function indexInputs(snapshot: MarketSnapshot): IndexInput[] {
  return snapshot.tokens.map((t) => ({
    symbol: t.token.symbol,
    sectors: t.token.sectors,
    impliedValuationUsd: t.marketUsd === null ? null : t.marketUsd * t.supplyUi,
    liquidityUsd: t.liquidityUsd,
    basis: t.basis,
  }));
}

/**
 * Value a weight set at current prices, as a level continuing from the last.
 *
 * The level is chained rather than recomputed from inception: weights change
 * as valuations move, and chaining period returns is what keeps a rebalancing
 * index comparable over time.
 */
function nextLevel(
  weights: readonly Weight[],
  priceNow: ReadonlyMap<string, number>,
  pricePrevious: ReadonlyMap<string, number> | null,
  previousLevel: number | null,
): number {
  if (pricePrevious === null || previousLevel === null) return INDEX_BASE;

  let periodReturn = 0;
  let covered = 0;
  for (const { symbol, weight } of weights) {
    const now = priceNow.get(symbol);
    const before = pricePrevious.get(symbol);
    if (now === undefined || before === undefined || before <= 0) continue;
    periodReturn += weight * (now / before - 1);
    covered += weight;
  }
  // Rescale to the part of the basket we could price, so a missing quote
  // damps the index toward zero return rather than inventing one.
  if (covered <= 0) return previousLevel;
  return previousLevel * (1 + periodReturn / covered);
}

export async function runJob(
  rpc: Rpc,
  jupiter: JupiterClient,
  store: Store,
): Promise<JobResult> {
  const snapshot = await takeSnapshot(rpc, jupiter);

  const previous = store.latestSnapshot();
  const previousPrices = previous ? priceMapFor(store, previous.id) : null;

  const snapshotId = store.writeSnapshot({
    takenAt: snapshot.takenAt,
    epoch: snapshot.epoch,
    prices: snapshot.tokens.map((t) => ({
      symbol: t.token.symbol,
      marketUsd: t.marketUsd,
      markUsd: t.markUsd,
      liquidityUsd: t.liquidityUsd,
      multiplier: t.multiplier,
      transferFeeBps: t.transferFeeBps,
    })),
  });

  const priceNow = new Map<string, number>();
  for (const t of snapshot.tokens) {
    if (t.marketUsd !== null) priceNow.set(t.token.symbol, t.marketUsd);
  }

  // Trades. Reconstructed from transaction history rather than holder
  // snapshots, because every free endpoint refuses getTokenLargestAccounts
  // outright. Indexing is incremental: each mint remembers the newest
  // signature it has seen.
  let tradesWritten = 0;
  let tradersSeen = 0;
  let tradeError: string | null = null;
  // Held until the trades are durably written, so a failure between parsing
  // and writing does not skip the window on the next run.
  const pendingCursors: { mint: string; signature: string }[] = [];
  let missedSignatures = 0;

  try {
    const mints = snapshot.tokens.map((t) => t.token.mint);
    const mintStates = await getMintStates(rpc, mints);
    const watched = new Set(mints);
    const rows: TradeRow[] = [];

    for (const mint of mints) {
      const cursor = store.cursorFor(mint);
      const { signatures, complete } = await getSignaturesSince(rpc, mint, {
        until: cursor ?? undefined,
        pageSize: SIGNATURES_PER_MINT,
      });
      if (signatures.length === 0) continue;

      const { trades, missed } = await fetchTrades(
        rpc,
        signatures.filter((s) => !s.err).map((s) => s.signature),
        watched,
      );

      // Advance the cursor only after the window has been parsed. Advancing
      // before that loses those transactions for good, since nothing looks at
      // the range again.
      //
      // On a bootstrap run there is no cursor and therefore no gap to
      // preserve: the scan simply defines where indexing starts, so the
      // cursor is set whether or not the scan ran out of pages. Requiring
      // completeness here is a trap -- these mints have unbounded history, so
      // a first run always exhausts its page budget, the cursor is never
      // written, and every later run re-scans the same signatures forever.
      //
      // Once a cursor exists, completeness does matter: a partial scan means
      // the window between this page and the old cursor was never read, and
      // moving the cursor past it would skip those transactions permanently.
      // A batch that failed to fetch leaves a hole in this window, so the
      // cursor stays put and the window is read again next pass. Writes are
      // keyed on signature, so re-reading costs a request, not a duplicate.
      const newest = signatures[0];
      const isBootstrap = cursor === null;
      if (newest && missed === 0 && (complete || isBootstrap)) {
        pendingCursors.push({ mint, signature: newest.signature });
      }
      if (missed > 0) missedSignatures += missed;

      for (const trade of trades) {
        const token = byMint(trade.mint);
        const mintState = mintStates.get(trade.mint);
        if (!token || !mintState) continue;

        // Signed amounts have to be scaled through their magnitude: rawToUi
        // takes an unsigned base-unit count.
        const magnitude = trade.deltaRaw < 0n ? -trade.deltaRaw : trade.deltaRaw;
        const uiMagnitude = rawToUi(
          magnitude,
          mintState.decimals,
          mintState.scale,
          snapshot.unixSeconds,
        );
        const uiAmount = trade.deltaRaw < 0n ? -uiMagnitude : uiMagnitude;
        const price = priceNow.get(token.symbol);

        rows.push({
          signature: trade.signature,
          owner: trade.owner,
          symbol: token.symbol,
          slot: trade.slot,
          blockTime: trade.blockTime,
          deltaRaw: trade.deltaRaw,
          uiAmount,
          valueUsd: price === undefined ? null : uiAmount * price,
        });
      }
    }

    tradesWritten = store.writeTrades(rows);
    tradersSeen = new Set(rows.map((r) => r.owner)).size;
    for (const cursor of pendingCursors) store.setCursor(cursor.mint, cursor.signature);
  } catch (error) {
    // Trade indexing is the most fragile part of the job. Losing it must not
    // cost the snapshot and index levels that already succeeded.
    tradeError = (error as Error).message;
  }

  // Index levels.
  const inputs = indexInputs(snapshot);
  let indexesWritten = 0;
  for (const definition of INDEX_DEFINITIONS) {
    const portfolio = buildIndex(definition, inputs);
    if (!portfolio) continue;

    const previousLevel = previous ? lastLevel(store, definition.id) : null;
    store.writeIndexLevel({
      indexId: definition.id,
      snapshotId,
      level: nextLevel(portfolio.weights, priceNow, previousPrices, previousLevel),
      weights: portfolio.weights,
    });
    indexesWritten++;
  }

  return {
    snapshotId,
    snapshot,
    tradesWritten,
    tradersSeen,
    indexesWritten,
    missedSignatures,
    tradeError,
  };
}

function priceMapFor(store: Store, snapshotId: number): Map<string, number> {
  const rows = store.raw
    .query("SELECT symbol, market_usd AS marketUsd FROM token_price WHERE snapshot_id = ?")
    .all(snapshotId) as { symbol: string; marketUsd: number | null }[];
  const prices = new Map<string, number>();
  for (const row of rows) if (row.marketUsd !== null) prices.set(row.symbol, row.marketUsd);
  return prices;
}

function lastLevel(store: Store, indexId: string): number | null {
  const row = store.raw
    .query(
      `SELECT l.level AS level FROM index_level l
       JOIN market_snapshot s ON s.id = l.snapshot_id
       WHERE l.index_id = ? ORDER BY s.taken_at DESC LIMIT 1`,
    )
    .get(indexId) as { level: number } | null;
  return row?.level ?? null;
}
