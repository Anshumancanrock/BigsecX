/**
 * Build one consistent view of the market.
 *
 * "Consistent" is the operative word. Prices, mint state, and the epoch all
 * come from different places and all move, so a snapshot fixes a single
 * timestamp and epoch and derives everything from those. Otherwise a split
 * taking effect mid-refresh, or an epoch rolling over between two calls, yields
 * a view whose numbers disagree with each other.
 */

import {
  ALL_MINTS,
  UNIVERSE,
  basis,
  basisLabel,
  byMint,
  currentMultiplier,
  epochFee,
  pendingFeeChange,
  rawToUi,
  type BasisLabel,
  type PreStock,
} from "@ps/core";
import { Rpc, getMintStates, type MintState } from "@ps/chain";
import type { JupiterClient, PriceEntry } from "@ps/market";

export interface TokenView {
  readonly token: PreStock;
  /** Multiplier in force at the snapshot timestamp. */
  readonly multiplier: number;
  /** Supply in UI shares. */
  readonly supplyUi: number;
  readonly marketUsd: number | null;
  readonly markUsd: number | null;
  /** Market over mark, as a fraction. Null when the mark is unavailable. */
  readonly basis: number | null;
  readonly basisLabel: BasisLabel | null;
  readonly liquidityUsd: number;
  readonly change24hPct: number;
  /** Transfer fee in force this epoch, in basis points. */
  readonly transferFeeBps: number;
  readonly paused: boolean;
}

export interface MarketSnapshot {
  readonly takenAt: Date;
  readonly unixSeconds: number;
  readonly epoch: number;
  readonly tokens: readonly TokenView[];
  readonly totalLiquidityUsd: number;
  /** Set when a transfer fee change is scheduled but not yet live. */
  readonly pendingFeeChange: { readonly fromBps: number; readonly toBps: number; readonly atEpoch: number } | null;
  /** Symbols whose data was incomplete; surfaced rather than hidden. */
  readonly degraded: readonly string[];
}

function buildTokenView(
  token: PreStock,
  mint: MintState,
  price: PriceEntry | undefined,
  epoch: number,
  unixSeconds: number,
): TokenView {
  const multiplier = currentMultiplier(mint.scale, unixSeconds);
  const supplyUi = rawToUi(mint.rawSupply, mint.decimals, mint.scale, unixSeconds);

  // Jupiter's usdPrice is already multiplier-corrected; stockData.price is the
  // issuer mark. Both are per UI share, so they are directly comparable.
  const marketUsd = price?.usdPrice ?? null;
  const markUsd = price?.stockData?.price ?? null;

  const basisFraction =
    marketUsd !== null && markUsd !== null && markUsd !== 0 ? marketUsd / markUsd - 1 : null;

  return {
    token,
    multiplier,
    supplyUi,
    marketUsd,
    markUsd,
    basis: basisFraction,
    basisLabel: basisLabel(basisFraction),
    liquidityUsd: price?.liquidity ?? 0,
    change24hPct: price?.priceChange24h ?? 0,
    transferFeeBps: epochFee(mint.transferFee, epoch).transferFeeBasisPoints,
    paused: mint.paused,
  };
}

export async function takeSnapshot(
  rpc: Rpc,
  jupiter: JupiterClient,
): Promise<MarketSnapshot> {
  // Pin the epoch and the clock before reading anything derived from them.
  const [epoch, mints, prices] = await Promise.all([
    rpc.epoch(),
    getMintStates(rpc, ALL_MINTS),
    jupiter.prices(ALL_MINTS),
  ]);
  const takenAt = new Date();
  const unixSeconds = Math.floor(takenAt.getTime() / 1000);

  const degraded: string[] = [];
  const tokens: TokenView[] = [];

  for (const token of UNIVERSE) {
    const mint = mints.get(token.mint);
    if (!mint) {
      degraded.push(token.symbol);
      continue;
    }
    const view = buildTokenView(token, mint, prices[token.mint], epoch, unixSeconds);
    if (view.marketUsd === null || view.markUsd === null) degraded.push(token.symbol);
    tokens.push(view);
  }

  // The fee schedule is identical across these mints, so read it from any of
  // them; fall back to null if the universe somehow came back empty.
  const anyMint = mints.get(UNIVERSE[0]?.mint ?? "");

  return {
    takenAt,
    unixSeconds,
    epoch,
    tokens,
    totalLiquidityUsd: tokens.reduce((sum, t) => sum + t.liquidityUsd, 0),
    pendingFeeChange: anyMint ? pendingFeeChange(anyMint.transferFee, epoch) : null,
    degraded,
  };
}

/** Resolve a mint to its symbol for display. */
export function symbolOf(mint: string): string {
  return byMint(mint)?.symbol ?? mint.slice(0, 6);
}
