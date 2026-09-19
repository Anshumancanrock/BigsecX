/**
 * The Portfolio primitive.
 *
 * A portfolio is nothing but a set of target weights over the universe. Who
 * authored those weights is metadata, not structure: a thematic index is a
 * portfolio a rule produced, a leaderboard trader is a portfolio a person
 * produced, and a user's own allocation is a portfolio they produced. Mirroring
 * is therefore one operation -- move my holdings toward those weights -- and
 * indexes, social copying and self-directed rebalancing are three surfaces over
 * it rather than three subsystems.
 *
 * Everything here is pure. Quotes and depth limits live in `execution.ts`,
 * which consumes the orders this module produces.
 */

export type PortfolioKind = "index" | "trader" | "user";

export interface Weight {
  readonly symbol: string;
  /** Fraction of the portfolio, in [0, 1]. */
  readonly weight: number;
}

export interface Portfolio {
  readonly id: string;
  readonly name: string;
  readonly kind: PortfolioKind;
  readonly weights: readonly Weight[];
}

/** A position expressed in UI (multiplier-adjusted) shares. */
export interface Holding {
  readonly symbol: string;
  readonly uiAmount: number;
}

export type Side = "buy" | "sell";

export interface RebalanceOrder {
  readonly symbol: string;
  readonly side: Side;
  /** Notional to trade, in USD, always positive. */
  readonly usd: number;
  /** Portfolio weight before the trade. */
  readonly fromWeight: number;
  /** Portfolio weight the trade targets. */
  readonly toWeight: number;
}

/**
 * Drop non-positive weights and rescale the rest to sum to exactly 1.
 *
 * Callers routinely build weights from valuations or scores that do not sum to
 * anything in particular, so normalising is the entry point to everything else.
 * Throws rather than returning an empty portfolio: silently allocating nothing
 * is worse than failing loudly.
 */
export function normalizeWeights(weights: readonly Weight[]): Weight[] {
  const positive = weights.filter((w) => w.weight > 0 && Number.isFinite(w.weight));
  const total = positive.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) throw new RangeError("normalizeWeights: no positive weights");
  return positive.map((w) => ({ symbol: w.symbol, weight: w.weight / total }));
}

/**
 * Cap any single position and redistribute the excess proportionally.
 *
 * Without a cap, valuation weighting puts most of the portfolio in one or two
 * names -- SpaceX and Anthropic alone carry the bulk of this universe's implied
 * valuation. Iterates because redistributing can push another name over the cap.
 */
export function capWeights(weights: readonly Weight[], maxWeight: number): Weight[] {
  if (maxWeight <= 0 || maxWeight > 1) throw new RangeError("capWeights: maxWeight must be in (0, 1]");

  const base = normalizeWeights(weights);
  // A cap below an equal split is unsatisfiable.
  if (maxWeight * base.length < 1 - 1e-12) {
    throw new RangeError(
      `capWeights: ${base.length} positions cannot fit under a ${maxWeight} cap`,
    );
  }

  // Each pass recomputes every uncapped weight from the ORIGINAL proportions
  // against the weight left over after the capped names take their cap. An
  // earlier version redistributed onto the previous pass's output, which let a
  // name that had just been capped receive weight again and breach the cap.
  const capped = new Set<string>();
  for (let pass = 0; pass <= base.length; pass++) {
    const remaining = 1 - capped.size * maxWeight;
    const uncapped = base.filter((w) => !capped.has(w.symbol));
    if (uncapped.length === 0) break;

    const uncappedTotal = uncapped.reduce((sum, w) => sum + w.weight, 0);
    const share = (w: Weight) =>
      uncappedTotal > 0 ? (w.weight / uncappedTotal) * remaining : remaining / uncapped.length;

    const breaching = uncapped.filter((w) => share(w) > maxWeight + 1e-12);
    if (breaching.length === 0) {
      return base.map((w) =>
        capped.has(w.symbol) ? { symbol: w.symbol, weight: maxWeight } : { symbol: w.symbol, weight: share(w) },
      );
    }
    for (const w of breaching) capped.add(w.symbol);
  }

  // Every name is at the cap, which only happens when the cap is exactly 1/n.
  return base.map((w) => ({ symbol: w.symbol, weight: maxWeight }));
}

/** Value each holding and express the portfolio as weights. */
export function currentWeights(
  holdings: readonly Holding[],
  priceUsdBySymbol: ReadonlyMap<string, number>,
): { readonly weights: Weight[]; readonly totalUsd: number } {
  const valued = holdings
    .map((h) => ({ symbol: h.symbol, usd: h.uiAmount * (priceUsdBySymbol.get(h.symbol) ?? 0) }))
    .filter((v) => v.usd > 0);

  const totalUsd = valued.reduce((sum, v) => sum + v.usd, 0);
  if (totalUsd <= 0) return { weights: [], totalUsd: 0 };
  return {
    weights: valued.map((v) => ({ symbol: v.symbol, weight: v.usd / totalUsd })),
    totalUsd,
  };
}

/** Signed distance from current weight to target weight, per symbol. */
export function drift(
  current: readonly Weight[],
  target: readonly Weight[],
): { readonly symbol: string; readonly current: number; readonly target: number; readonly drift: number }[] {
  const currentBySymbol = new Map(current.map((w) => [w.symbol, w.weight]));
  const targetBySymbol = new Map(target.map((w) => [w.symbol, w.weight]));

  const symbols = new Set([...currentBySymbol.keys(), ...targetBySymbol.keys()]);
  return [...symbols]
    .map((symbol) => {
      const c = currentBySymbol.get(symbol) ?? 0;
      const t = targetBySymbol.get(symbol) ?? 0;
      return { symbol, current: c, target: t, drift: t - c };
    })
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
}

export interface RebalanceRequest {
  readonly target: readonly Weight[];
  readonly holdings: readonly Holding[];
  readonly priceUsdBySymbol: ReadonlyMap<string, number>;
  /**
   * Fresh capital to deploy, in USD. When positive, the portfolio grows to
   * `currentValue + deployUsd` and existing positions are only sold if the
   * target demands it.
   */
  readonly deployUsd?: number;
  /**
   * Skip legs smaller than this. Every leg pays a transfer fee plus spread, so
   * a $3 rebalance destroys more value than the drift it corrects.
   */
  readonly minTicketUsd?: number;
  /**
   * Leave weights alone while they are within this fraction of target.
   * Prevents churn on noise in a market this thin.
   */
  readonly toleranceBps?: number;
  /** Sell positions that the target does not include. Defaults to true. */
  readonly liquidateUntargeted?: boolean;
}

export interface RebalancePlan {
  readonly orders: readonly RebalanceOrder[];
  readonly portfolioValueUsd: number;
  readonly targetValueUsd: number;
  /** Legs dropped for being below `minTicketUsd` or inside tolerance. */
  readonly skipped: readonly { readonly symbol: string; readonly usd: number; readonly reason: string }[];
}

/**
 * Turn a target allocation into the trades that reach it.
 *
 * Sells are emitted before buys. That ordering is not cosmetic: a rebalance
 * funded from existing positions must realise the USD before spending it, and
 * emitting the list in execution order means the caller can sign it as-is.
 */
export function planRebalance(request: RebalanceRequest): RebalancePlan {
  const {
    target,
    holdings,
    priceUsdBySymbol,
    deployUsd = 0,
    minTicketUsd = 5,
    toleranceBps = 50,
    liquidateUntargeted = true,
  } = request;

  const normalizedTarget = normalizeWeights(target);
  const { totalUsd: currentValueUsd } = currentWeights(holdings, priceUsdBySymbol);
  const targetValueUsd = currentValueUsd + deployUsd;
  if (targetValueUsd <= 0) {
    return { orders: [], portfolioValueUsd: currentValueUsd, targetValueUsd: 0, skipped: [] };
  }

  const currentUsdBySymbol = new Map<string, number>();
  for (const h of holdings) {
    const price = priceUsdBySymbol.get(h.symbol);
    if (price === undefined) continue;
    currentUsdBySymbol.set(h.symbol, (currentUsdBySymbol.get(h.symbol) ?? 0) + h.uiAmount * price);
  }

  const targetBySymbol = new Map(normalizedTarget.map((w) => [w.symbol, w.weight]));
  const symbols = new Set([...currentUsdBySymbol.keys(), ...targetBySymbol.keys()]);

  const orders: RebalanceOrder[] = [];
  const skipped: { symbol: string; usd: number; reason: string }[] = [];
  const tolerance = toleranceBps / 10_000;

  for (const symbol of symbols) {
    const heldUsd = currentUsdBySymbol.get(symbol) ?? 0;
    const targetWeight = targetBySymbol.get(symbol) ?? 0;

    // A position outside the target is either liquidated or left untouched.
    if (targetWeight === 0 && !liquidateUntargeted) continue;

    const wantUsd = targetWeight * targetValueUsd;
    const deltaUsd = wantUsd - heldUsd;
    if (deltaUsd === 0) continue;

    const fromWeight = currentValueUsd > 0 ? heldUsd / currentValueUsd : 0;
    const weightGap = Math.abs(targetWeight - fromWeight);

    if (weightGap < tolerance && targetWeight > 0) {
      skipped.push({ symbol, usd: Math.abs(deltaUsd), reason: "within tolerance" });
      continue;
    }
    if (Math.abs(deltaUsd) < minTicketUsd) {
      skipped.push({ symbol, usd: Math.abs(deltaUsd), reason: "below minimum ticket" });
      continue;
    }

    orders.push({
      symbol,
      side: deltaUsd > 0 ? "buy" : "sell",
      usd: Math.abs(deltaUsd),
      fromWeight,
      toWeight: targetWeight,
    });
  }

  // Sells first so the buys they fund are covered; largest leg first within
  // each side, because that is the one most likely to hit a depth limit and
  // the caller may want to stop early.
  orders.sort((a, b) =>
    a.side === b.side ? b.usd - a.usd : a.side === "sell" ? -1 : 1,
  );

  return { orders, portfolioValueUsd: currentValueUsd, targetValueUsd, skipped };
}
