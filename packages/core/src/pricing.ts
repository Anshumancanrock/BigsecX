/**
 * Price models for a PreStock. Each token has a mark (the issuer's valuation of
 * the underlying SPV exposure, moving on funding rounds rather than trades) and
 * a market price on Solana DEXs. With thin liquidity and no retail redemption
 * path the two can stay apart for weeks; their gap is the basis.
 */

import { currentMultiplier, type ScaledUiAmountConfig } from "./units.ts";

export interface PriceSnapshot {
  readonly symbol: string;
  /** DEX price per UI share, in USD, already corrected for the multiplier. */
  readonly marketUsd: number;
  readonly markUsd: number | null;
  readonly liquidityUsd: number;
  readonly change24hPct: number;
  readonly asOf: Date;
}

/**
 * Premium (positive) or discount (negative) of market to mark, as a fraction.
 *
 * Null when there is no mark (the issuer API returns a null tokenPrice for some
 * symbols). Callers must show the absence; zero would read as fairly priced.
 */
export function basis(snapshot: PriceSnapshot): number | null {
  if (snapshot.markUsd === null || snapshot.markUsd === 0) return null;
  return snapshot.marketUsd / snapshot.markUsd - 1;
}

export type BasisLabel = "deep-discount" | "discount" | "fair" | "premium" | "rich";

/**
 * Bucket a basis for display. Thresholds suit this market rather than
 * equities: a 2% dislocation is noise here, 10% is a real signal.
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
 * Jupiter's `outAmount` is in raw base units and ignores the ScaledUiAmount
 * multiplier; skipping it overstates the price by that factor (5x for SPACEX).
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
