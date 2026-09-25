/**
 * Profit and loss from observed trades: pnl = markValue - netInvested, where
 * netInvested sums signed trade values (buys positive) and markValue prices the
 * net position now; this holds for open and closed positions alike. Only trades
 * since indexing began are seen; `coverageComplete` flags unreliable figures.
 */

export interface TradeRecord {
  readonly owner: string;
  readonly symbol: string;
  readonly uiAmount: number;
  readonly valueUsd: number | null;
  readonly slot: number;
}

export interface TraderPnl {
  readonly owner: string;
  readonly trades: number;
  readonly volumeUsd: number;
  readonly netInvestedUsd: number;
  readonly peakInvestedUsd: number;
  readonly markValueUsd: number;
  readonly pnlUsd: number;
  /** Profit over money at risk. Null when the wallet never had any at risk. */
  readonly returnFraction: number | null;
  readonly positions: readonly { readonly symbol: string; readonly uiAmount: number }[];
  /**
   * False when the profit figure cannot be trusted: the wallet sold shares
   * acquired before indexing began, or a trade had no believable cost.
   */
  readonly coverageComplete: boolean;
}

/**
 * How far a trade's implied price may sit from today's before its cost is
 * treated as unknown rather than believed.
 */
const MAX_PRICE_RATIO = 4;

/**
 * Whether a trade's recorded cost can be believed.
 *
 * The indexer attributes a transaction's cash to the token leg it found, which
 * is wrong when the transaction also moved other assets. A buy must cost money,
 * a sale must return it, and the implied price must be within MAX_PRICE_RATIO
 * of today's. A failing trade keeps its shares but loses its cost.
 */
export function believableCost(
  trade: Pick<TradeRecord, "uiAmount" | "valueUsd">,
  priceUsd: number | undefined,
): boolean {
  if (trade.valueUsd === null || trade.uiAmount === 0) return false;
  if (Math.sign(trade.valueUsd) !== Math.sign(trade.uiAmount)) return false;
  if (priceUsd === undefined || priceUsd <= 0) return true;
  const implied = Math.abs(trade.valueUsd / trade.uiAmount);
  return implied <= priceUsd * MAX_PRICE_RATIO && implied >= priceUsd / MAX_PRICE_RATIO;
}

export function computeTraderPnl(
  owner: string,
  trades: readonly TradeRecord[],
  priceBySymbol: ReadonlyMap<string, number>,
): TraderPnl {
  const position = new Map<string, number>();
  const runningMinimum = new Map<string, number>();

  let netInvestedUsd = 0;
  let peakInvestedUsd = 0;
  let volumeUsd = 0;
  let unpriced = false;

  for (const trade of [...trades].sort((a, b) => a.slot - b.slot)) {
    const next = (position.get(trade.symbol) ?? 0) + trade.uiAmount;
    position.set(trade.symbol, next);

    const lowest = runningMinimum.get(trade.symbol);
    if (lowest === undefined || next < lowest) runningMinimum.set(trade.symbol, next);

    if (trade.valueUsd === null || !believableCost(trade, priceBySymbol.get(trade.symbol))) {
      // Shares moved without a credible cost (an unpriced swap, a transfer, or
      // cash from another leg). Marking the shares with no cost would turn a
      // deposit into profit, so the wallet is flagged instead.
      unpriced = true;
      continue;
    }
    netInvestedUsd += trade.valueUsd;
    if (netInvestedUsd > peakInvestedUsd) peakInvestedUsd = netInvestedUsd;
    volumeUsd += Math.abs(trade.valueUsd);
  }

  let markValueUsd = 0;
  const positions: { symbol: string; uiAmount: number }[] = [];
  for (const [symbol, uiAmount] of position) {
    if (Math.abs(uiAmount) < 1e-9) continue;
    positions.push({ symbol, uiAmount });
    markValueUsd += uiAmount * (priceBySymbol.get(symbol) ?? 0);
  }

  // A position that went negative means shares were sold that this never saw
  // bought, so the cost basis is missing a leg.
  const coverageComplete =
    !unpriced && [...runningMinimum.values()].every((low) => low >= -1e-9);

  const pnlUsd = markValueUsd - netInvestedUsd;
  // A wallet that only ever sold committed nothing, so it has no return.
  const atRisk = peakInvestedUsd;

  return {
    owner,
    trades: trades.length,
    volumeUsd,
    netInvestedUsd,
    peakInvestedUsd,
    markValueUsd,
    pnlUsd,
    returnFraction: atRisk > 0 ? pnlUsd / atRisk : null,
    positions,
    coverageComplete,
  };
}

export interface LeaderboardOptions {
  readonly minVolumeUsd?: number;
  readonly limit?: number;
  /**
   * Drop wallets whose cost basis is incomplete. On by default, since selling a
   * pre-existing bag shows as a large fake profit.
   */
  readonly requireCoverage?: boolean;
  readonly sortBy?: "pnl" | "return" | "volume";
}

export function buildLeaderboard(
  byOwner: ReadonlyMap<string, readonly TradeRecord[]>,
  priceBySymbol: ReadonlyMap<string, number>,
  options: LeaderboardOptions = {},
): TraderPnl[] {
  const {
    minVolumeUsd = 100,
    limit = 25,
    requireCoverage = true,
    sortBy = "pnl",
  } = options;

  const rows: TraderPnl[] = [];
  for (const [owner, trades] of byOwner) {
    const pnl = computeTraderPnl(owner, trades, priceBySymbol);
    if (pnl.volumeUsd < minVolumeUsd) continue;
    if (requireCoverage && !pnl.coverageComplete) continue;
    rows.push(pnl);
  }

  const key = (row: TraderPnl) =>
    sortBy === "volume" ? row.volumeUsd : sortBy === "return" ? (row.returnFraction ?? -Infinity) : row.pnlUsd;

  return rows.sort((a, b) => key(b) - key(a)).slice(0, limit);
}
