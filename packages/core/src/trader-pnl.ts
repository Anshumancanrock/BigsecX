/**
 * Profit and loss reconstructed from observed trades.
 *
 * This replaces an earlier holdings-difference approach that could not tell a
 * deposit from a good trade. Every indexed trade carries both the signed share
 * change and its USD value, so cost basis is directly observable and the
 * result is an actual profit figure rather than a proxy for one.
 *
 * Accounting, stated plainly because a leaderboard that hides its method is
 * not trustworthy:
 *
 *   netInvested = sum of signed trade values. A buy spends (positive), a sell
 *                 returns (negative). A wallet that has sold more than it
 *                 bought has a negative number here.
 *   position    = sum of signed share changes, per symbol.
 *   markValue   = position valued at the current price.
 *   pnl         = markValue - netInvested
 *
 * That identity holds whether a position was closed, is still open, or both,
 * so realised and unrealised profit need no separate treatment.
 *
 * The honest caveat, which callers must surface: this only sees trades since
 * indexing began. A wallet holding a position bought earlier shows its later
 * trades against a mark value that includes shares this never priced, so its
 * figure is wrong until the whole position turns over. `coverage` reports
 * whether the wallet's reconstructed position ever went negative, which is the
 * signature of a pre-existing holding being sold.
 */

export interface TradeRecord {
  readonly owner: string;
  readonly symbol: string;
  /** Signed share change. Positive is a buy. */
  readonly uiAmount: number;
  /** Signed USD value. Positive is money spent. Null when unpriced. */
  readonly valueUsd: number | null;
  readonly slot: number;
}

export interface TraderPnl {
  readonly owner: string;
  readonly trades: number;
  /** Absolute USD traded, both directions. */
  readonly volumeUsd: number;
  readonly netInvestedUsd: number;
  /**
   * The most capital the wallet ever had committed at once.
   *
   * This, not the closing balance, is the denominator for return. After a
   * round trip `netInvestedUsd` collapses to the profit or loss itself, so
   * dividing by it reports every losing trade as exactly -100%.
   */
  readonly peakInvestedUsd: number;
  readonly markValueUsd: number;
  readonly pnlUsd: number;
  /** Profit over money at risk. Null when the wallet never had any at risk. */
  readonly returnFraction: number | null;
  readonly positions: readonly { readonly symbol: string; readonly uiAmount: number }[];
  /**
   * False when the wallet sold shares it held before indexing started, which
   * makes its cost basis incomplete and its profit figure unreliable.
   */
  readonly coverageComplete: boolean;
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

  // Trades must be applied in execution order for the running-minimum check
  // to mean anything.
  for (const trade of [...trades].sort((a, b) => a.slot - b.slot)) {
    const next = (position.get(trade.symbol) ?? 0) + trade.uiAmount;
    position.set(trade.symbol, next);

    const lowest = runningMinimum.get(trade.symbol);
    if (lowest === undefined || next < lowest) runningMinimum.set(trade.symbol, next);

    if (trade.valueUsd !== null) {
      netInvestedUsd += trade.valueUsd;
      if (netInvestedUsd > peakInvestedUsd) peakInvestedUsd = netInvestedUsd;
      volumeUsd += Math.abs(trade.valueUsd);
    }
  }

  let markValueUsd = 0;
  const positions: { symbol: string; uiAmount: number }[] = [];
  for (const [symbol, uiAmount] of position) {
    // Dust below a nanoshare is rounding, not a position.
    if (Math.abs(uiAmount) < 1e-9) continue;
    positions.push({ symbol, uiAmount });
    markValueUsd += uiAmount * (priceBySymbol.get(symbol) ?? 0);
  }

  // A position that went negative means shares were sold that this never saw
  // bought, so the cost basis is missing a leg.
  const coverageComplete = [...runningMinimum.values()].every((low) => low >= -1e-9);

  const pnlUsd = markValueUsd - netInvestedUsd;
  // Return is profit over the most that was ever committed, not over what is
  // left committed. A wallet that only ever sold committed nothing and so has
  // no meaningful return.
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
  /** Ignore wallets that traded less than this in the window. */
  readonly minVolumeUsd?: number;
  readonly limit?: number;
  /**
   * Drop wallets whose cost basis is incomplete. On by default: a wallet that
   * sold a pre-existing bag shows an enormous fake profit and would top the
   * board.
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
