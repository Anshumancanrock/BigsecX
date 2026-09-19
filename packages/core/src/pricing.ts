/**
 * Price models for a PreStock.
 *
 * Two prices exist for every one of these tokens and they routinely disagree:
 *
 *   mark   -- the issuer's valuation of the underlying SPV exposure, published
 *             through the PreStocks API. It moves on funding rounds and
 *             secondary marks, not on trades.
 *   market -- what the token actually changes hands for on Solana DEXs.
 *
 * The gap between them is the most informative number in this market. It is
 * not an error to be smoothed away: with roughly $2.6M of total DEX liquidity
 * and no retail redemption path, the two can stay apart for weeks. On
 * 2026-09-19 SPACEX traded 20% below its mark and NEURALINK 24% above.
 */

import { currentMultiplier, type ScaledUiAmountConfig } from "./units.ts";

export interface PriceSnapshot {
  readonly symbol: string;
  /** DEX price per UI share, in USD, already corrected for the multiplier. */
  readonly marketUsd: number;
  /** Issuer mark price per UI share, in USD. Null when the API omits it. */
  readonly markUsd: number | null;
  /** Quotable DEX liquidity in USD, as reported by the aggregator. */
  readonly liquidityUsd: number;
  readonly change24hPct: number;
  readonly asOf: Date;
}

/**
 * Premium (positive) or discount (negative) of market to mark, as a fraction.
 *
 * Returns null when the issuer has not published a mark, which happens -- the
 * API returns a null tokenPrice for some symbols. Callers must render the
 * absence rather than substituting zero, which would read as "fairly priced".
 */
export function basis(snapshot: PriceSnapshot): number | null {
  if (snapshot.markUsd === null || snapshot.markUsd === 0) return null;
  return snapshot.marketUsd / snapshot.markUsd - 1;
}

export type BasisLabel = "deep-discount" | "discount" | "fair" | "premium" | "rich";

/**
 * Bucket a basis for display.
 *
 * Thresholds are set against what this market actually does rather than
 * borrowed from equities: a 2% dislocation is noise here, 10% is a real signal.
 */
export function basisLabel(basisFraction: number | null): BasisLabel | null {
  if (basisFraction === null) return null;
  if (basisFraction <= -0.1) return "deep-discount";
  if (basisFraction <= -0.02) return "discount";
  if (basisFraction < 0.02) return "fair";
  if (basisFraction < 0.1) return "premium";
  return "rich";
}

/**
 * Convert an aggregator quote into a price per UI share.
 *
 * `outAmount` from Jupiter is in raw base units and carries no knowledge of the
 * ScaledUiAmount multiplier, so this is the only correct way to turn a quote
 * into a number a user can read. Skipping the multiplier overstates OPENAI by
 * 49% and SPACEX by 400%.
 */
export function quoteToUiPrice(args: {
  readonly inUsd: number;
  readonly outRaw: bigint;
  readonly decimals: number;
  readonly scale: ScaledUiAmountConfig;
  readonly atUnixSeconds: number;
}): number {
  const outUi = (Number(args.outRaw) / 10 ** args.decimals) *
    currentMultiplier(args.scale, args.atUnixSeconds);
  if (outUi === 0) throw new RangeError("quoteToUiPrice: quote returned zero output");
  return args.inUsd / outUi;
}

/** Total portfolio value in USD. */
export function portfolioValueUsd(
  holdings: readonly { readonly symbol: string; readonly uiAmount: number }[],
  priceBySymbol: ReadonlyMap<string, number>,
): number {
  let total = 0;
  for (const h of holdings) {
    const price = priceBySymbol.get(h.symbol);
    if (price === undefined) continue;
    total += h.uiAmount * price;
  }
  return total;
}
