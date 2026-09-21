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
import { discoverVenues, type JupiterClient } from "@ps/market";
import { Store, type TradeRow } from "@ps/db";
import { takeSnapshot, type MarketSnapshot } from "@ps/market";

/** Index levels start here, so a chart reads as a percentage from launch. */
const INDEX_BASE = 1_000;

/** USDC has six decimals; wrapped SOL has nine. */
const USDC_DECIMALS = 6;
const WSOL_DECIMALS = 9;
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;
/**
 * Below this, a lamport change is rent, not a trade.
 *
 * Opening an associated token account costs about 0.00204 SOL and closing it
 * returns the same, so small balance movements are account churn rather than
 * consideration. Only used for the native-SOL fallback.
 */
const MIN_LAMPORT_TRADE = 5_000_000;

/**
 * What a trade cost, taken from the stablecoin that actually moved.
 *
 * Earlier this multiplied the share change by the CURRENT snapshot price,
 * which destroys the measurement it exists to make: a buy and a later sell of
 * the same shares get the same price, so profit reconstructs to roughly zero
 * for everyone. Worse, the real figure was already being parsed out of the
 * transaction and discarded.
 *
 * Sign convention matches the rest of the profit accounting: positive is
 * money spent. A buy drains USDC, so the wallet's USDC delta is negative and
 * the value is its negation.
 *
 * Returns null when no stablecoin leg is attributable -- a swap routed
 * through SOL, or a plain transfer. Such a trade has no observable cost
 * basis, and pricing it with a mark would invent one.
 */
function tradeValueUsd(
  usdcDeltaRaw: bigint | null,
  wsolDeltaRaw: bigint | null,
  lamportDeltaRaw: bigint | null,
  solUsd: number | null,
): number | null {
  if (usdcDeltaRaw !== null && usdcDeltaRaw !== 0n) {
    return -Number(usdcDeltaRaw) / 10 ** USDC_DECIMALS;
  }
  // Most routes hop through SOL rather than stablecoin, so falling back to
  // the SOL leg is the difference between pricing a quarter of observed
  // trades and pricing nearly all of them.
  //
  // The SOL amount is the one that actually moved in that transaction, and it
  // differs between a buy and a later sell -- which is what keeps profit
  // measurable. Only the SOL/USD rate is taken as of now, and that is a
  // liquid pair moving far less than these thin tokens do.
  if (wsolDeltaRaw !== null && wsolDeltaRaw !== 0n && solUsd !== null && solUsd > 0) {
    return (-Number(wsolDeltaRaw) / 10 ** WSOL_DECIMALS) * solUsd;
  }
  // Native lamports last, and only for movements too large to be rent.
  // Measured on mainnet: SOL-routed swaps show nothing in the wrapped account
  // because Jupiter wraps and unwraps within the transaction, so this is the
  // only place their cost appears.
  if (
    lamportDeltaRaw !== null &&
    solUsd !== null &&
    solUsd > 0 &&
    (lamportDeltaRaw > BigInt(MIN_LAMPORT_TRADE) || lamportDeltaRaw < BigInt(-MIN_LAMPORT_TRADE))
  ) {
    return (-Number(lamportDeltaRaw) / LAMPORTS_PER_SOL) * solUsd;
  }
  return null;
}

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

/** Signatures pulled per address per pass. */
const SIGNATURES_PER_MINT = Number(process.env["SIGNATURES_PER_MINT"] ?? 15);
/**
 * Pool accounts scanned per pass, on top of the eight mints.
 *
 * Bounded because each address costs at least one signature request and the
 * free tier has little room. Venues are ordered by discovery, which follows
 * the sizes probed, so the ones carrying real flow come first.
 */
const MAX_VENUES = Number(process.env["MAX_VENUES"] ?? 10);
/**
 * Pages of signatures spent on a mint, versus a pool.
 *
 * Measured on mainnet from ten signatures each: the OPENAI mint yielded
 * seven failed transactions, three with no token movement, and zero trades,
 * while its DLMM pool yielded three. A mint's signature list is dominated by
 * bot spam and account churn, so it gets a single page and the pools get the
 * budget.
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
 * Continue an index level by one period.
 *
 * The return of a finished period has to be measured with the basket that was
 * held during it, which is the weight set persisted alongside the previous
 * level -- not the weights just recomputed from today's valuations. Using
 * today's weights back-dates every rebalance, crediting the index with
 * holding more of whatever has since rallied.
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
  const pendingCursors: { address: string; signature: string }[] = [];
  let missedSignatures = 0;
  let venuesScanned = 0;
  let skippedBacklog = 0;

  try {
    const mints = snapshot.tokens.map((t) => t.token.mint);
    const mintStates = await getMintStates(rpc, mints);
    const watched = new Set(mints);
    const rows: TradeRow[] = [];

    // SOL is priced once per pass and used to value the SOL side of trades.
    let solUsd: number | null = null;
    try {
      const solPrice = await jupiter.prices([WSOL_MINT]);
      solUsd = solPrice[WSOL_MINT]?.usdPrice ?? null;
    } catch {
      // Without a SOL price, only stablecoin-legged trades get a cost.
      solUsd = null;
    }

    // Pools first: nearly everything touching them is a trade, whereas a
    // mint's signature list is mostly transfers and account creations.
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
    for (const address of [...venueAddresses, ...mints]) {
      const cursor = store.cursorFor(address);
      const { signatures, complete } = await getSignaturesSince(rpc, address, {
        until: cursor ?? undefined,
        pageSize: SIGNATURES_PER_MINT,
        ...(venueSet.has(address) ? {} : { maxPages: MINT_PAGES }),
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
      // Advance whenever the window was read cleanly. An incomplete scan
      // leaves a gap, and that gap is reported -- but refusing to advance
      // stalls the address forever: after any downtime the backlog exceeds
      // the page budget on every pass, so `complete` is never true and the
      // same signatures are re-read indefinitely while new ones pile up.
      // Forward progress with a counted gap beats a permanent stall.
      const newest = signatures[0];
      if (newest && missed === 0) {
        pendingCursors.push({ address, signature: newest.signature });
        if (!complete) skippedBacklog++;
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
        rows.push({
          signature: trade.signature,
          owner: trade.owner,
          symbol: token.symbol,
          slot: trade.slot,
          blockTime: trade.blockTime,
          deltaRaw: trade.deltaRaw,
          uiAmount,
          valueUsd: tradeValueUsd(
            trade.usdcDeltaRaw,
            trade.wsolDeltaRaw,
            trade.lamportDeltaRaw,
            solUsd,
          ),
        });
      }
    }

    tradesWritten = store.writeTrades(rows);
    tradersSeen = new Set(rows.map((r) => r.owner)).size;
    for (const cursor of pendingCursors) store.setCursor(cursor.address, cursor.signature);
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

    // The previous level and the basket that earned it travel together.
    const last = previous ? store.lastIndexState(definition.id) : null;
    store.writeIndexLevel({
      indexId: definition.id,
      snapshotId,
      level: nextLevel(last?.weights ?? portfolio.weights, priceNow, previousPrices, last?.level ?? null),
      // Tomorrow's period is earned by the basket chosen today.
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

