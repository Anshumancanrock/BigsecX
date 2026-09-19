/**
 * Execution policy: deciding what a rebalance leg should actually cost, and
 * refusing the ones that cost too much.
 *
 * This market has roughly $2.6M of quotable depth spread across eight tokens,
 * and the thinnest of them holds under $100k. A plan that assumes it can move
 * arbitrary size is a plan that quietly hands users 50% price impact -- a
 * measured $50k NEURALINK order came back at 56.8% impact and a 132% premium.
 * So every leg is checked against a real quote at its real size, and a leg that
 * cannot be filled inside its budget is resized or deferred, never silently
 * executed.
 *
 * Pure. The caller supplies quote results; `market/planner.ts` runs the loop.
 */

import type { RebalanceOrder } from "./portfolio.ts";
import { calculateFee, type TransferFee } from "./transfer-fee.ts";

export interface ExecutionLimits {
  /** Reject or resize a leg whose price impact exceeds this. */
  readonly maxImpactBps: number;
  /** Never shrink a leg below this; defer it instead. */
  readonly minTicketUsd: number;
  /** Cap on how much of a pool's quotable depth one leg may consume. */
  readonly maxDepthShareBps?: number;
}

/**
 * How much a re-quote must improve to count as depth rather than spread.
 *
 * If halving the order barely moves the rate, the cost is the bid-ask spread
 * and shrinking further buys nothing while degrading index tracking.
 */
export const SPREAD_FLOOR_RATIO = 0.9;

export const DEFAULT_LIMITS: ExecutionLimits = {
  // 2% is generous for equities and about right here: below it, legs in the
  // thinner names would almost never clear.
  maxImpactBps: 200,
  minTicketUsd: 5,
  // Taking more than a tenth of quotable depth moves the price against every
  // later leg in the same basket.
  maxDepthShareBps: 1_000,
};

/** What a quote told us about one leg at one size. */
export interface LegProbe {
  readonly symbol: string;
  readonly usd: number;
  /** Price impact as a fraction, from the aggregator. */
  readonly priceImpact: number;
  /** Quotable USD depth for this token. */
  readonly liquidityUsd: number;
}

/**
 * Why a leg was resized.
 *
 * The distinction matters. A `depth` cap is a hard limit -- the pool is only so
 * big and taking more of it moves the price against every later leg. An
 * `impact` cap is a guess that a smaller order will fill better, and in an
 * order book with a wide spread that guess is wrong: the cost is a floor, not a
 * function of size. The planner treats the two differently.
 */
export type ResizeCause = "depth" | "impact";

export type LegVerdict =
  | { readonly kind: "accept"; readonly usd: number }
  | { readonly kind: "resize"; readonly usd: number; readonly cause: ResizeCause; readonly reason: string }
  | { readonly kind: "defer"; readonly reason: string };

/**
 * Judge one leg against the limits.
 *
 * Resizing uses the square-root rule: for a constant-product pool, impact grows
 * roughly with the square of trade size relative to depth, so halving impact
 * means shrinking size by about sqrt(2). It is an estimate, which is why the
 * caller re-quotes at the suggested size rather than trusting it.
 */
export function judgeLeg(probe: LegProbe, limits: ExecutionLimits = DEFAULT_LIMITS): LegVerdict {
  const maxImpact = limits.maxImpactBps / 10_000;

  if (limits.maxDepthShareBps !== undefined && probe.liquidityUsd > 0) {
    const maxUsd = (probe.liquidityUsd * limits.maxDepthShareBps) / 10_000;
    if (probe.usd > maxUsd) {
      if (maxUsd < limits.minTicketUsd) {
        return {
          kind: "defer",
          reason: `only $${probe.liquidityUsd.toFixed(0)} quotable depth; no size clears the cap`,
        };
      }
      return {
        kind: "resize",
        usd: maxUsd,
        cause: "depth",
        reason: `capped at ${limits.maxDepthShareBps / 100}% of $${probe.liquidityUsd.toFixed(0)} depth`,
      };
    }
  }

  if (probe.priceImpact > maxImpact) {
    const scale = Math.sqrt(maxImpact / probe.priceImpact);
    const resized = probe.usd * scale;
    if (resized < limits.minTicketUsd) {
      return {
        kind: "defer",
        reason: `${(probe.priceImpact * 100).toFixed(2)}% impact; no size above the minimum clears ${limits.maxImpactBps}bps`,
      };
    }
    return {
      kind: "resize",
      usd: resized,
      cause: "impact",
      reason: `${(probe.priceImpact * 100).toFixed(2)}% impact exceeds ${limits.maxImpactBps}bps`,
    };
  }

  return { kind: "accept", usd: probe.usd };
}

/**
 * Transfer fee cost of moving `usd` of a PreStock, in USD.
 *
 * Charged on the token leg of every swap, in both directions, so a round trip
 * pays it twice. At the live 50 bps that is 1% before spread; from epoch 1039
 * it is 2%.
 */
export function transferFeeCostUsd(usd: number, feeBps: number): number {
  return (usd * feeBps) / 10_000;
}

/** Exact fee in raw base units, for display alongside a quote. */
export function transferFeeRaw(rawAmount: bigint, fee: TransferFee): bigint {
  return calculateFee(fee, rawAmount);
}

export interface PlannedLeg {
  readonly order: RebalanceOrder;
  /** Size after any resize, in USD. */
  readonly usd: number;
  readonly priceImpact: number;
  readonly transferFeeUsd: number;
  readonly note: string | null;
}

export interface ExecutionPlan {
  readonly legs: readonly PlannedLeg[];
  readonly deferred: readonly { readonly symbol: string; readonly usd: number; readonly reason: string }[];
  readonly totalUsd: number;
  readonly totalImpactUsd: number;
  readonly totalTransferFeeUsd: number;
  /** All-in cost as a fraction of notional traded. */
  readonly costFraction: number;
}

/** Aggregate judged legs into a plan with an honest total cost. */
export function summarize(
  legs: readonly PlannedLeg[],
  deferred: readonly { readonly symbol: string; readonly usd: number; readonly reason: string }[],
): ExecutionPlan {
  const totalUsd = legs.reduce((sum, l) => sum + l.usd, 0);
  const totalImpactUsd = legs.reduce((sum, l) => sum + l.usd * l.priceImpact, 0);
  const totalTransferFeeUsd = legs.reduce((sum, l) => sum + l.transferFeeUsd, 0);

  return {
    legs,
    deferred,
    totalUsd,
    totalImpactUsd,
    totalTransferFeeUsd,
    costFraction: totalUsd > 0 ? (totalImpactUsd + totalTransferFeeUsd) / totalUsd : 0,
  };
}
