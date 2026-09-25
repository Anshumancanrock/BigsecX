/**
 * One indexing pass: records a market snapshot, new trades and each index's
 * level. Leaderboards, index charts and trader mirroring read what it writes.
 */

import { INDEX_DEFINITIONS, buildIndex, type IndexInput, type Weight } from "@ps/core";
import { Rpc, fetchTrades, getMintStates, getSignaturesSince } from "@ps/chain";
import { discoverVenues, tradeRows, type JupiterClient } from "@ps/market";
import { Store, type TradeRow } from "@ps/db";
import { takeSnapshot, type MarketSnapshot } from "@ps/market";

/** Index levels start here, so a chart reads as a percentage from launch. */
const INDEX_BASE = 1_000;

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface JobResult {
  readonly snapshotId: number;
  readonly snapshot: MarketSnapshot;
  readonly tradesWritten: number;
  readonly tradersSeen: number;
  readonly indexesWritten: number;
  /** Signatures whose fetch failed; their windows will be retried. */
  readonly missedSignatures: number;
  /** Addresses whose backlog exceeded the page budget, leaving a gap. */
  readonly skippedBacklog: number;
  /** Pool accounts scanned this pass, on top of the mints. */
  readonly venuesScanned: number;
  /** Set when trade indexing failed but the snapshot still succeeded. */
  readonly tradeError: string | null;
}

/** Signatures per page when scanning an address. */
const SIGNATURES_PER_MINT = Number(process.env["SIGNATURES_PER_MINT"] ?? 15);
/**
 * Pool accounts scanned per pass, on top of the mints. Bounded because each
 * costs at least one signature request against a free-tier RPC.
 */
const MAX_VENUES = Number(process.env["MAX_VENUES"] ?? 10);
/**
 * Signature pages per mint scan. A mint's signature list is mostly failed
 * transactions and account churn, so the page budget goes to pools instead.
 */
const MINT_PAGES = 1;

function indexInputs(snapshot: MarketSnapshot): IndexInput[] {
  return snapshot.tokens.map((t) => ({
    symbol: t.token.symbol,
    sectors: t.token.sectors,
    impliedValuationUsd: t.marketUsd === null ? null : t.marketUsd * t.supplyUi,
    liquidityUsd: t.liquidityUsd,
    basis: t.basis,
    paused: t.paused,
  }));
}

/**
 * Advances an index level by one period using the weights held during it
 * (stored with the previous level). Today's weights would back-date the
 * rebalance and credit the index with whatever has since rallied.
 */
function nextLevel(
  weightsInForce: readonly Weight[],
  priceNow: ReadonlyMap<string, number>,
  pricePrevious: ReadonlyMap<string, number> | null,
  previousLevel: number | null,
): number {
  if (pricePrevious === null || previousLevel === null) return INDEX_BASE;
  const weights = weightsInForce;

  let periodReturn = 0;
  let covered = 0;
  for (const { symbol, weight } of weights) {
    const now = priceNow.get(symbol);
    const before = pricePrevious.get(symbol);
    if (now === undefined || before === undefined || before <= 0) continue;
    periodReturn += weight * (now / before - 1);
    covered += weight;
  }
  // Return over the priced part of the basket only; with nothing priced the
  // level is unchanged.
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

  // Trades, from transaction history, since free RPC endpoints refuse
  // getTokenLargestAccounts. Each address keeps a cursor at its newest signature.
  let tradesWritten = 0;
  let tradersSeen = 0;
  let tradeError: string | null = null;
  // Held until the trades are durably written, so a failure between parsing
  // and writing does not skip the window on the next run.
  const pendingCursors: { address: string; signature: string }[] = [];
  let missedSignatures = 0;
  let venuesScanned = 0;
  let skippedBacklog = 0;

  try {
    const mints = snapshot.tokens.map((t) => t.token.mint);
    const mintStates = await getMintStates(rpc, mints);
    const watched = new Set(mints);
    const rows: TradeRow[] = [];

    // SOL is priced once per pass to value the SOL side of trades.
    let solUsd: number | null = null;
    try {
      const solPrice = await jupiter.prices([WSOL_MINT]);
      solUsd = solPrice[WSOL_MINT]?.usdPrice ?? null;
    } catch {
      // Without a SOL price, only stablecoin-legged trades get a cost.
      solUsd = null;
    }

    // Pools first: nearly every transaction on a pool is a trade.
    let venueAddresses: string[] = [];
    try {
      const venues = await discoverVenues(jupiter, snapshot.tokens.map((t) => t.token));
      venueAddresses = venues.slice(0, MAX_VENUES).map((v) => v.ammKey);
      venuesScanned = venueAddresses.length;
    } catch {
      // Venue discovery is an optimisation. Without it the mints still index.
      venueAddresses = [];
    }

    const venueSet = new Set(venueAddresses);
    let failedAddresses = 0;
    let firstAddressError: string | null = null;
    for (const address of [...venueAddresses, ...mints]) {
      const cursor = store.cursorFor(address);
      // A failed address (stale cursor, rate limit) must not discard the trades
      // already parsed from the others.
      let scan: Awaited<ReturnType<typeof getSignaturesSince>>;
      let fetched: Awaited<ReturnType<typeof fetchTrades>>;
      try {
        scan = await getSignaturesSince(rpc, address, {
          until: cursor ?? undefined,
          pageSize: SIGNATURES_PER_MINT,
          ...(venueSet.has(address) ? {} : { maxPages: MINT_PAGES }),
        });
        if (scan.signatures.length === 0) continue;
        fetched = await fetchTrades(
          rpc,
          scan.signatures.filter((s) => !s.err).map((s) => s.signature),
          watched,
        );
      } catch (error) {
        failedAddresses++;
        firstAddressError ??= (error as Error).message;
        continue;
      }
      const { signatures, complete } = scan;
      const { trades, missed } = fetched;

      // Advance the cursor only if every fetch succeeded; otherwise the window is
      // re-read next pass (writes are keyed on signature). An incomplete scan
      // still advances so a backlog cannot stall the address; the gap is counted.
      const newest = signatures[0];
      if (newest && missed === 0) {
        pendingCursors.push({ address, signature: newest.signature });
        if (!complete) skippedBacklog++;
      }
      if (missed > 0) missedSignatures += missed;

      rows.push(...tradeRows(trades, mintStates, snapshot.unixSeconds, solUsd));
    }

    tradesWritten = store.writeTrades(rows);
    tradersSeen = new Set(rows.map((r) => r.owner)).size;
    for (const cursor of pendingCursors) store.setCursor(cursor.address, cursor.signature);
    if (failedAddresses > 0) {
      tradeError = `${failedAddresses} address${failedAddresses === 1 ? "" : "es"} could not be read: ${firstAddressError}`;
    }
  } catch (error) {
    // Trade indexing is the most fragile step; its failure is reported without
    // losing the snapshot or the index levels.
    tradeError = (error as Error).message;
  }

  // Index levels.
  const inputs = indexInputs(snapshot);
  let indexesWritten = 0;
  for (const definition of INDEX_DEFINITIONS) {
    const portfolio = buildIndex(definition, inputs);
    if (!portfolio) continue;

    // The previous level and the basket that earned it travel together.
    const last = previous ? store.lastIndexState(definition.id) : null;
    store.writeIndexLevel({
      indexId: definition.id,
      snapshotId,
      level: nextLevel(last?.weights ?? portfolio.weights, priceNow, previousPrices, last?.level ?? null),
      // The next period is measured with the basket chosen now.
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
    skippedBacklog,
    venuesScanned,
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

