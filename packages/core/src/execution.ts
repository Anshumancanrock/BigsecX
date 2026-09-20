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
 * Transfer fee embedded in a fill of `usd`, in USD.
 *
 * The aggregator quotes net of this fee, so it is already paid inside the price
 * a user sees. This computes it only so the UI can name the charge. The fee is
 * assessed on the GROSS amount the pool sent, so recovering it from the net
 * figure means grossing up first, not multiplying the net by the rate.
 *
 * Charged on the token leg of every swap in both directions, so a round trip
 * pays it twice: 1% at the live 50 bps, and 2% once epoch 1039 lands.
 */
export function transferFeeCostUsd(netUsd: number, feeBps: number): number {
  if (feeBps <= 0 || !Number.isFinite(netUsd)) return 0;
  // A 100% fee leaves nothing to gross up from; the division would be by zero
  // and anything above it would flip the sign.
  if (feeBps >= 10_000) return Number.POSITIVE_INFINITY;
  const gross = (netUsd * 10_000) / (10_000 - feeBps);
  return gross - netUsd;
}

/** Exact fee in raw base units, for display alongside a quote. */
export function transferFeeRaw(rawAmount: bigint, fee: TransferFee): bigint {
  return calculateFee(fee, rawAmount);
}

/**
 * One leg, priced against a live quote.
 *
 * Cost is measured as the realized price versus a reference price, not
 * assembled from parts. That choice is deliberate and was forced by a mainnet
 * simulation: Jupiter's `outAmount` is already NET of the Token-2022 transfer
 * fee. A simulated $500 buy quoted 486,197,930 base units and credited exactly
 * 486,197,930 spendable units, with 2,443,206 withheld separately as the fee --
 * 0.5000% of the gross the pool sent. Adding a fee line on top of that quote,
 * which an earlier version of this module did, charges the user twice.
 *
 * So `transferFeeUsd` here is a disclosure, not an addend. The real cost of a
 * leg is `costVsReference`, which contains spread, price impact and the fee
 * together, because that is what the fill actually gives up.
 */
export interface PlannedLeg {
  readonly order: RebalanceOrder;
  /** Size actually sent, in USD, after any resize. */
  readonly usd: number;
  /** Price impact as reported by the aggregator. */
  readonly priceImpact: number;
  /** Shares received net of fee, in UI units. Null when not measurable. */
  readonly expectedOutUi: number | null;
  /** Price per UI share the quote implies, all-in. */
  readonly effectivePriceUsd: number | null;
  /** Mid price the cost is measured against. */
  readonly referencePriceUsd: number | null;
  /**
   * Realized cost as a fraction of notional: spread, impact and transfer fee
   * combined. Positive means worse than reference.
   */
  readonly costVsReference: number | null;
  /**
   * Transfer fee already embedded in the quote, in USD. Shown so a user can
   * see what the asset charges; never added to the total.
   */
  readonly transferFeeUsd: number;
  readonly note: string | null;
}

export interface ExecutionPlan {
  readonly legs: readonly PlannedLeg[];
  readonly deferred: readonly { readonly symbol: string; readonly usd: number; readonly reason: string }[];
  readonly totalUsd: number;
  /** Total realized cost in USD, from measured fills. */
  readonly totalCostUsd: number;
  /** Transfer fee contained within that cost, for disclosure. */
  readonly totalTransferFeeUsd: number;
  /** Realized cost as a fraction of notional traded. */
  readonly costFraction: number;
}

/**
 * Aggregate judged legs into a plan.
 *
 * Legs whose cost could not be measured fall back to price impact, which
 * understates them; they are still counted rather than dropped, because a leg
 * silently excluded from a total is worse than one counted imprecisely.
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
