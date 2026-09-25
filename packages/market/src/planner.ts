/**
 * Prices a rebalance against live depth: each leg is quoted at its trade size,
 * judged against depth and impact limits, and re-quoted once if it shrinks.
 * Whether a Jupiter quote nets the Token-2022 transfer fee depends on the route,
 * so the fee is taken off every quote (at worst one fee pessimistic).
 */

import {
  DEFAULT_LIMITS,
  SPREAD_FLOOR_RATIO,
  USDC_DECIMALS,
  USDC_MINT,
  bySymbol,
  judgeLeg,
  summarize,
  transferFeeCostUsd,
  type ExecutionLimits,
  type ExecutionPlan,
  type PlannedLeg,
  type RebalanceOrder,
} from "@ps/core";
import type { JupiterClient, Quote } from "./jupiter.ts";
import { priceImpact } from "./jupiter.ts";

export interface PlanRequest {
  readonly orders: readonly RebalanceOrder[];
  readonly liquidityUsdBySymbol: ReadonlyMap<string, number>;
  readonly priceUsdBySymbol: ReadonlyMap<string, number>;
  /**
   * Active ScaledUiAmount multiplier per symbol, for converting between UI
   * shares and the raw base units quotes use.
   */
  readonly scaleBySymbol: ReadonlyMap<string, number>;
  /** Transfer fee the legs pay when they land, in basis points. Taken off every quote. */
  readonly transferFeeBps: number;
  readonly limits?: ExecutionLimits;
  /**
   * Account cap per route. Must match the builder's, or the planned cost is for
   * a different route than the one built.
   */
  readonly maxAccounts?: number;
}

interface Probe {
  readonly impact: number;
  readonly effectivePriceUsd: number;
  /** Shares received, less the transfer fee. Buys only; null for sells. */
  readonly outUi: number | null;
}

async function probeLeg(
  jupiter: JupiterClient,
  order: RebalanceOrder,
  usd: number,
  request: PlanRequest,
): Promise<Probe> {
  const token = bySymbol(order.symbol);
  if (!token) throw new Error(`planner: unknown symbol ${order.symbol}`);

  const multiplier = request.scaleBySymbol.get(order.symbol);
  if (multiplier === undefined || multiplier <= 0) {
    throw new Error(`planner: no scale multiplier for ${order.symbol}`);
  }

  let quote: Quote;
  let effectivePriceUsd: number;
  let outUi: number | null = null;
  // Fraction left after the transfer fee; every quote is treated as not netting it.
  const afterFee = 1 - Math.min(Math.max(request.transferFeeBps, 0), 10_000) / 10_000;

  if (order.side === "buy") {
    quote = await jupiter.quote({
      inputMint: USDC_MINT,
      outputMint: token.mint,
      amount: BigInt(Math.round(usd * 10 ** USDC_DECIMALS)),
      ...(request.maxAccounts !== undefined ? { maxAccounts: request.maxAccounts } : {}),
    });
    outUi = (Number(quote.outAmount) / 10 ** token.decimals) * multiplier * afterFee;
    if (outUi <= 0) throw new Error(`planner: ${order.symbol} quote returned nothing`);
    effectivePriceUsd = usd / outUi;
  } else {
    const price = request.priceUsdBySymbol.get(order.symbol);
    if (price === undefined || price <= 0) {
      throw new Error(`planner: no price for ${order.symbol}`);
    }
    // Sizing a sell needs raw units: shares divided by the multiplier.
    const uiAmount = usd / price;
    const rawAmount = BigInt(Math.round((uiAmount / multiplier) * 10 ** token.decimals));
    quote = await jupiter.quote({
      inputMint: token.mint,
      outputMint: USDC_MINT,
      amount: rawAmount > 0n ? rawAmount : 1n,
      ...(request.maxAccounts !== undefined ? { maxAccounts: request.maxAccounts } : {}),
    });
    // The fee comes off the shares on their way into the pool, so the pool
    // pays out on that much less.
    const proceedsUsd = (Number(quote.outAmount) / 10 ** USDC_DECIMALS) * afterFee;
    if (uiAmount <= 0) throw new Error(`planner: ${order.symbol} sell size is zero`);
    effectivePriceUsd = proceedsUsd / uiAmount;
  }

  return { impact: priceImpact(quote), effectivePriceUsd, outUi };
}

/**
 * Realized cost against the reference price as a fraction, positive when worse
 * for the user. Spread, impact and fee are all inside it, so none is added separately.
 */
function costVsReference(
  side: RebalanceOrder["side"],
  effective: number,
  reference: number | undefined,
): number | null {
  if (reference === undefined || reference <= 0) return null;
  return side === "buy" ? effective / reference - 1 : 1 - effective / reference;
}

export async function buildExecutionPlan(
  jupiter: JupiterClient,
  request: PlanRequest,
): Promise<ExecutionPlan> {
  const limits = request.limits ?? DEFAULT_LIMITS;

  const planOrder = async (
    order: RebalanceOrder,
  ): Promise<{ leg?: PlannedLeg; deferred?: { symbol: string; usd: number; reason: string } }> => {
    const liquidityUsd = request.liquidityUsdBySymbol.get(order.symbol) ?? 0;
    const reference = request.priceUsdBySymbol.get(order.symbol);

    let probe: Probe;
    try {
      probe = await probeLeg(jupiter, order, order.usd, request);
    } catch (error) {
      // An unpriced leg is deferred, never executed.
      return {
        deferred: {
          symbol: order.symbol,
          usd: order.usd,
          reason: `could not quote: ${(error as Error).message}`,
        },
      };
    }

    const verdict = judgeLeg(
      { symbol: order.symbol, usd: order.usd, priceImpact: probe.impact, liquidityUsd },
      limits,
    );
    // An impact deferral means shrinking to the impact cap would go below the
    // minimum ticket. Such an order proceeds at full size if it meets the minimum
    // ticket and its impact is within the ceiling also used for a spread floor below.
    const ceiling = (limits.maxFloorImpactBps ?? limits.maxImpactBps) / 10_000;
    let floorNote: string | null = null;
    if (verdict.kind === "defer") {
      if (verdict.cause !== "impact" || order.usd < limits.minTicketUsd || probe.impact > ceiling) {
        return {
          deferred: {
            symbol: order.symbol,
            usd: order.usd,
            reason:
              verdict.cause === "impact" && probe.impact > ceiling
                ? `trading even $${limits.minTicketUsd} would cost ${(probe.impact * 100).toFixed(2)}% in price impact — more than the ${ceiling * 100}% we allow`
                : verdict.reason,
          },
        };
      }
      floorNote = `${(probe.impact * 100).toFixed(2)}% price impact at the smallest size there is`;
    }

    let usd = verdict.kind === "defer" ? order.usd : verdict.usd;
    let measuredAtUsd = order.usd;
    let note: string | null = floorNote ?? (verdict.kind === "resize" ? verdict.reason : null);

    if (verdict.kind === "resize") {
      const original = probe;
      let measured: Probe | null = null;
      try {
        // Re-quote so the reported figures are for the size that will be sent.
        measured = await probeLeg(jupiter, order, usd, request);
      } catch {
        note = `${verdict.reason} (impact estimated)`;
      }

      if (measured !== null) {
        const improved = measured.impact < original.impact * SPREAD_FLOOR_RATIO;

        if (!improved && verdict.cause === "impact") {
          // A smaller size did not lower the rate, so this is a spread floor, not a
          // depth limit. Keep the intended size and disclose the cost, unless the
          // floor itself is above the ceiling.
          if (original.impact > ceiling) {
            return {
              deferred: {
                symbol: order.symbol,
                usd: order.usd,
                reason: `costs ${(original.impact * 100).toFixed(2)}% in price impact at any size right now — more than the ${ceiling * 100}% we allow`,
              },
            };
          }
          usd = order.usd;
          probe = original;
          measuredAtUsd = order.usd;
          note = `${(original.impact * 100).toFixed(2)}% spread floor; smaller size does not reduce it`;
        } else {
          probe = measured;
          measuredAtUsd = usd;
          const recheck = judgeLeg(
            { symbol: order.symbol, usd, priceImpact: probe.impact, liquidityUsd },
            limits,
          );
          if (recheck.kind === "defer") {
            return { deferred: { symbol: order.symbol, usd: order.usd, reason: recheck.reason } };
          }
          // Only a depth cap resizes a second time. A second impact resize would
          // need a third quote for the reported impact to stay measured.
          if (recheck.kind === "resize" && recheck.cause === "depth") usd = recheck.usd;
        }
      }
    }

    return {
      leg: {
        order,
        usd,
        priceImpact: probe.impact,
        // Null when the size changed after the last quote, so it is always measured.
        expectedOutUi: measuredAtUsd === usd ? probe.outUi : null,
        effectivePriceUsd: probe.effectivePriceUsd,
        referencePriceUsd: reference ?? null,
        costVsReference: costVsReference(order.side, probe.effectivePriceUsd, reference),
        transferFeeUsd: transferFeeCostUsd(usd, request.transferFeeBps),
        note,
      },
    };
  };

  const outcomes = await Promise.all(request.orders.map(planOrder));
  const legs: PlannedLeg[] = [];
  const deferred: { symbol: string; usd: number; reason: string }[] = [];
  for (const outcome of outcomes) {
    if (outcome.leg) legs.push(outcome.leg);
    if (outcome.deferred) deferred.push(outcome.deferred);
  }
  return summarize(legs, deferred);
}
