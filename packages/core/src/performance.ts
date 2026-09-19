/**
 * Portfolio return from two holdings snapshots.
 *
 * The naive measure -- compare total value then and now -- rewards deposits.
 * A wallet that doubled because someone wired in more money would outrank one
 * that actually picked well, and a leaderboard built on that is worse than no
 * leaderboard, because it looks authoritative while ranking the wrong thing.
 *
 * So flows are estimated and removed. These tokens pay nothing and do not
 * rebase, so any change in share count is a trade or a transfer. Within a
 * portfolio, selling one name to buy another nets to roughly zero, which
 * leaves external deposits and withdrawals as the residual. Flows are valued
 * at the midpoint of the two prices, the usual approximation when the trade
 * time is unknown.
 *
 * What this cannot do, and callers must not claim it does: recover true profit
 * and loss. Cost basis is not observable from holdings alone, and a wallet
 * that traded heavily between two snapshots has activity this does not see.
 * The honest label is "return on observed holdings", not "trader PnL".
 */

export interface Position {
  readonly symbol: string;
  readonly uiAmount: number;
}

export interface PerformanceInput {
  readonly before: readonly Position[];
  readonly after: readonly Position[];
  readonly priceBefore: ReadonlyMap<string, number>;
  readonly priceAfter: ReadonlyMap<string, number>;
}

export interface Performance {
  readonly valueBefore: number;
  readonly valueAfter: number;
  /** Estimated external deposits (positive) or withdrawals (negative), USD. */
  readonly netFlowUsd: number;
  /** Return after removing flows, as a fraction. Null when there is no base. */
  readonly returnFraction: number | null;
}

function value(positions: readonly Position[], prices: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const position of positions) {
    total += position.uiAmount * (prices.get(position.symbol) ?? 0);
  }
  return total;
}

export function computePerformance(input: PerformanceInput): Performance {
  const valueBefore = value(input.before, input.priceBefore);
  const valueAfter = value(input.after, input.priceAfter);

  const sharesBefore = new Map(input.before.map((p) => [p.symbol, p.uiAmount]));
  const sharesAfter = new Map(input.after.map((p) => [p.symbol, p.uiAmount]));

  let netFlowUsd = 0;
  for (const symbol of new Set([...sharesBefore.keys(), ...sharesAfter.keys()])) {
    const delta = (sharesAfter.get(symbol) ?? 0) - (sharesBefore.get(symbol) ?? 0);
    if (delta === 0) continue;

    const before = input.priceBefore.get(symbol);
    const after = input.priceAfter.get(symbol);
    // A symbol priced at only one end still has to be valued; using the price
    // we do have beats discarding the flow and misattributing it to skill.
    const price =
      before !== undefined && after !== undefined
        ? (before + after) / 2
        : (after ?? before ?? 0);
    netFlowUsd += delta * price;
  }

  // Without a starting position there is no return to speak of, however much
  // value appeared. Reporting one would credit a deposit as performance.
  const returnFraction =
    valueBefore > 0 ? (valueAfter - valueBefore - netFlowUsd) / valueBefore : null;

  return { valueBefore, valueAfter, netFlowUsd, returnFraction };
}

export interface RankedWallet {
  readonly owner: string;
  readonly performance: Performance;
  readonly positions: readonly Position[];
}

/**
 * Rank wallets by flow-adjusted return.
 *
 * Wallets below `minValueUsd` are dropped. A $12 portfolio that doubled is
 * noise, and letting it top the board makes the whole list untrustworthy.
 */
export function rankWallets(
  wallets: readonly RankedWallet[],
  options: { readonly minValueUsd?: number; readonly limit?: number } = {},
): RankedWallet[] {
  const { minValueUsd = 1_000, limit = 50 } = options;
  return wallets
    .filter(
      (w) =>
        w.performance.returnFraction !== null &&
        w.performance.valueBefore >= minValueUsd &&
        w.performance.valueAfter >= minValueUsd,
    )
    .sort((a, b) => (b.performance.returnFraction ?? 0) - (a.performance.returnFraction ?? 0))
    .slice(0, limit);
}
