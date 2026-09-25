/**
 * Execution policy: judge each rebalance leg against a quote at its real size,
 * and resize or defer a leg that cannot fill inside its budget. The market has
 * about $2.6M of quotable depth across eight tokens, the thinnest under $100k.
 * Pure: the caller supplies quotes and `market/planner.ts` runs the loop.
 */

import type { RebalanceOrder } from "./portfolio.ts";
import { calculateFee, type TransferFee } from "./transfer-fee.ts";

export interface ExecutionLimits {
  readonly maxImpactBps: number;
  /** Never shrink a leg below this; defer it instead. */
  readonly minTicketUsd: number;
  readonly maxDepthShareBps?: number;
  /**
   * The most a leg may pay when shrinking it does not lower the rate, or it is
   * already at the minimum size. Up to this the cost is disclosed rather than
   * refused; past it the leg is not bought.
   */
  readonly maxFloorImpactBps?: number;
}

/**
 * How much a re-quote must improve to count as depth rather than spread. If a
 * smaller order barely moves the rate, the cost is the bid-ask spread and
 * shrinking further only degrades index tracking.
 */
export const SPREAD_FLOOR_RATIO = 0.9;

export const DEFAULT_LIMITS: ExecutionLimits = {
  // 2% is generous for equities and about right here: below it, legs in the
  // thinner names would almost never clear.
  maxImpactBps: 200,
  minTicketUsd: 5,
  maxDepthShareBps: 1_000,
  maxFloorImpactBps: 500,
};

export interface LegProbe {
  readonly symbol: string;
  readonly usd: number;
  readonly priceImpact: number;
  readonly liquidityUsd: number;
}

/**
 * Why a leg was resized. `depth` is a hard limit: taking more of the pool moves
 * the price against every later leg. `impact` is an estimate that a smaller
 * order fills better, which fails when the cost is a spread floor, so the
 * planner treats the two differently.
 */
export type ResizeCause = "depth" | "impact";

export type LegVerdict =
  | { readonly kind: "accept"; readonly usd: number }
  | { readonly kind: "resize"; readonly usd: number; readonly cause: ResizeCause; readonly reason: string }
  | {
      readonly kind: "defer";
      readonly reason: string;
      readonly cause: ResizeCause;
    };

/**
 * Judge one leg against the limits.
 *
 * Resizing uses the square-root rule (impact taken to grow with the square of
 * size relative to depth). It is an estimate, so the caller re-quotes at the
 * suggested size.
 */
export function judgeLeg(probe: LegProbe, limits: ExecutionLimits = DEFAULT_LIMITS): LegVerdict {
  const maxImpact = limits.maxImpactBps / 10_000;

  if (limits.maxDepthShareBps !== undefined && probe.liquidityUsd > 0) {
    const maxUsd = (probe.liquidityUsd * limits.maxDepthShareBps) / 10_000;
    if (probe.usd > maxUsd) {
      if (maxUsd < limits.minTicketUsd) {
        return {
          kind: "defer",
          cause: "depth",
          reason: `too little is on offer right now (about $${Math.round(probe.liquidityUsd).toLocaleString("en-US")}) to trade even $${limits.minTicketUsd} without moving the price`,
        };
      }
      return {
        kind: "resize",
        usd: maxUsd,
        cause: "depth",
        reason: `made smaller to stay within ${limits.maxDepthShareBps / 100}% of the roughly $${Math.round(probe.liquidityUsd).toLocaleString("en-US")} on offer`,
      };
    }
  }

  if (probe.priceImpact > maxImpact) {
    const scale = Math.sqrt(maxImpact / probe.priceImpact);
    const resized = probe.usd * scale;
    if (resized < limits.minTicketUsd) {
      return {
        kind: "defer",
        cause: "impact",
        reason: `trading even $${limits.minTicketUsd} would move its price ${(probe.priceImpact * 100).toFixed(2)}% — more than the ${limits.maxImpactBps / 100}% we allow`,
      };
    }
    return {
      kind: "resize",
      usd: resized,
      cause: "impact",
      reason: `made smaller: the full amount would move its price ${(probe.priceImpact * 100).toFixed(2)}%, more than the ${limits.maxImpactBps / 100}% we allow`,
    };
  }

  return { kind: "accept", usd: probe.usd };
}

/**
 * Transfer fee contained in a fill worth `netUsd`, in USD, for disclosure.
 *
 * The fee is assessed on the gross amount the pool sent, so it is recovered by
 * grossing up the net, not by multiplying the net by the rate. Every swap pays
 * it on the token leg, so a round trip pays it twice.
 */
export function transferFeeCostUsd(netUsd: number, feeBps: number): number {
  if (feeBps <= 0 || !Number.isFinite(netUsd)) return 0;
  // A 100% fee leaves nothing to gross up from; the division would be by zero
  // and anything above it would flip the sign.
  if (feeBps >= 10_000) return Number.POSITIVE_INFINITY;
  const gross = (netUsd * 10_000) / (10_000 - feeBps);
  return gross - netUsd;
}

export function slippageBpsFor(
  priceImpact: number,
  options: { readonly floorBps?: number; readonly capBps?: number; readonly headroom?: number } = {},
): number {
  const floorBps = options.floorBps ?? 150;
  const capBps = options.capBps ?? 1_000;
  const headroom = options.headroom ?? 1.5;

  const measured = Number.isFinite(priceImpact) && priceImpact > 0 ? priceImpact : 0;
  const derived = Math.ceil(measured * 10_000 * headroom) + floorBps;
  return Math.min(capBps, Math.max(floorBps, derived));
}

export function transferFeeRaw(rawAmount: bigint, fee: TransferFee): bigint {
  return calculateFee(fee, rawAmount);
}

/**
 * One leg, priced against a live quote.
 *
 * `costVsReference` compares the realized price (the quote less the transfer
 * fee; see the planner) with a reference, so it already includes spread,
 * impact and fee. `transferFeeUsd` is disclosure only; adding it to the cost
 * would count the fee twice.
 */
export interface PlannedLeg {
  readonly order: RebalanceOrder;
  readonly usd: number;
  readonly priceImpact: number;
  readonly expectedOutUi: number | null;
  readonly effectivePriceUsd: number | null;
  readonly referencePriceUsd: number | null;
  /**
   * Realized cost as a fraction of notional: spread, impact and transfer fee
   * combined. Positive means worse than reference.
   */
  readonly costVsReference: number | null;
  /**
   * Transfer fee already contained in the realized cost, in USD. Shown so a
   * user can see what the asset charges; never added to the total.
   */
  readonly transferFeeUsd: number;
  readonly note: string | null;
}

export interface ExecutionPlan {
  readonly legs: readonly PlannedLeg[];
  readonly deferred: readonly { readonly symbol: string; readonly usd: number; readonly reason: string }[];
  readonly totalUsd: number;
  readonly totalCostUsd: number;
  /** Transfer fee contained within that cost, for disclosure. */
  readonly totalTransferFeeUsd: number;
  readonly costFraction: number;
}

/**
 * Aggregate judged legs into a plan. A leg with no measured cost is counted at
 * its price impact, which understates it, rather than dropped from the total.
 */
export function summarize(
  legs: readonly PlannedLeg[],
  deferred: readonly { readonly symbol: string; readonly usd: number; readonly reason: string }[],
): ExecutionPlan {
  const totalUsd = legs.reduce((sum, l) => sum + l.usd, 0);
  const totalCostUsd = legs.reduce(
    (sum, l) => sum + l.usd * (l.costVsReference ?? l.priceImpact),
    0,
  );
  const totalTransferFeeUsd = legs.reduce((sum, l) => sum + l.transferFeeUsd, 0);

  return {
    legs,
    deferred,
    totalUsd,
    totalCostUsd,
    totalTransferFeeUsd,
    costFraction: totalUsd > 0 ? totalCostUsd / totalUsd : 0,
  };
}
