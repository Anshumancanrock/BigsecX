import type { IndexInput } from "@ps/core";
import type { MarketSnapshot } from "@ps/market";

export function indexInputs(snapshot: MarketSnapshot): IndexInput[] {
  return snapshot.tokens.map((t) => ({
    symbol: t.token.symbol,
    sectors: t.token.sectors,
    impliedValuationUsd: t.marketUsd === null ? null : t.marketUsd * t.supplyUi,
    liquidityUsd: t.liquidityUsd,
    basis: t.basis,
    paused: t.paused,
  }));
}

/** Price, liquidity and multiplier per symbol, plus a scale config for the balance readers. */
export function priceMaps(snapshot: MarketSnapshot) {
  const price = new Map<string, number>();
  const liquidity = new Map<string, number>();
  const scale = new Map<string, number>();
  // The snapshot has already resolved the active multiplier, so the config
  // reports it as fixed rather than scheduling a change.
  const scaleConfig = new Map<
    string,
    { multiplier: number; newMultiplier: number; newMultiplierEffectiveTimestamp: number }
  >();

  for (const t of snapshot.tokens) {
    if (t.marketUsd !== null) price.set(t.token.symbol, t.marketUsd);
    liquidity.set(t.token.symbol, t.liquidityUsd);
    scale.set(t.token.symbol, t.multiplier);
    scaleConfig.set(t.token.symbol, {
      multiplier: t.multiplier,
      newMultiplier: t.multiplier,
      newMultiplierEffectiveTimestamp: 0,
    });
  }
  return { price, liquidity, scale, scaleConfig };
}
