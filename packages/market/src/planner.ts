/**
 * Turn a rebalance into an execution plan priced against live depth.
 *
 * The core module decides policy; this module pays for the information that
 * policy needs. Each leg is quoted at the size it would actually trade, judged,
 * and -- if it was too large -- re-quoted once at the suggested smaller size.
 * One re-quote, not a search: the aggregator is rate limited, and a second
 * opinion is enough to turn an estimate into a measured number.
 */

import {
  DEFAULT_LIMITS,
  judgeLeg,
  summarize,
  transferFeeCostUsd,
  type ExecutionLimits,
  type ExecutionPlan,
  type PlannedLeg,
  type RebalanceOrder,
} from "@ps/core";
import { SPREAD_FLOOR_RATIO } from "@ps/core";
import { USDC_DECIMALS, USDC_MINT, bySymbol } from "@ps/core";
import type { JupiterClient } from "./jupiter.ts";
import { priceImpact } from "./jupiter.ts";

export interface PlanRequest {
  readonly orders: readonly RebalanceOrder[];
  /** Quotable depth per symbol, from the price feed. */
  readonly liquidityUsdBySymbol: ReadonlyMap<string, number>;
  /** Price per UI share, used to size sell legs in token terms. */
  readonly priceUsdBySymbol: ReadonlyMap<string, number>;
  /**
   * Active ScaledUiAmount multiplier per symbol. Sell legs are sized in raw
   * base units, and raw units are UI units divided by the multiplier. Getting
   * this wrong sells five times too much SPACEX.
   */
  readonly scaleBySymbol: ReadonlyMap<string, number>;
  /** Transfer fee in force this epoch. */
  readonly transferFeeBps: number;
  readonly limits?: ExecutionLimits;
}

/** Quote one leg and report its price impact at that size. */
async function probe(
  jupiter: JupiterClient,
  order: RebalanceOrder,
  usd: number,
  request: PlanRequest,
): Promise<number> {
  const token = bySymbol(order.symbol);
  if (!token) throw new Error(`planner: unknown symbol ${order.symbol}`);

  if (order.side === "buy") {
    const amount = BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
    const quote = await jupiter.quote({
      inputMint: USDC_MINT,
      outputMint: token.mint,
      amount,
    });
    return priceImpact(quote);
  }

  // Sizing a sell needs the token amount, so convert through the UI price.
  // Raw base units carry no multiplier, so go via uiToRaw rather than dividing
  // the USD figure by the price and scaling naively.
  const price = request.priceUsdBySymbol.get(order.symbol);
  if (price === undefined || price <= 0) {
    throw new Error(`planner: no price for ${order.symbol}`);
  }
  const multiplier = request.scaleBySymbol.get(order.symbol);
  if (multiplier === undefined || multiplier <= 0) {
    throw new Error(`planner: no scale multiplier for ${order.symbol}`);
  }
  // The caller's price is per UI share, so raw units are
  // (usd / price) / multiplier x 10^decimals.
  const uiAmount = usd / price;
  const rawAmount = BigInt(Math.round((uiAmount / multiplier) * 10 ** token.decimals));
  const quote = await jupiter.quote({
    inputMint: token.mint,
    outputMint: USDC_MINT,
    amount: rawAmount > 0n ? rawAmount : 1n,
  });
  return priceImpact(quote);
}

export async function buildExecutionPlan(
  jupiter: JupiterClient,
  request: PlanRequest,
): Promise<ExecutionPlan> {
  const limits = request.limits ?? DEFAULT_LIMITS;
  const legs: PlannedLeg[] = [];
  const deferred: { symbol: string; usd: number; reason: string }[] = [];

  for (const order of request.orders) {
    const liquidityUsd = request.liquidityUsdBySymbol.get(order.symbol) ?? 0;

    let impact: number;
    try {
      impact = await probe(jupiter, order, order.usd, request);
    } catch (error) {
      // A leg we cannot price is a leg we must not execute.
      deferred.push({
        symbol: order.symbol,
        usd: order.usd,
        reason: `could not quote: ${(error as Error).message}`,
      });
      continue;
    }

    const verdict = judgeLeg(
      { symbol: order.symbol, usd: order.usd, priceImpact: impact, liquidityUsd },
      limits,
    );

    if (verdict.kind === "defer") {
      deferred.push({ symbol: order.symbol, usd: order.usd, reason: verdict.reason });
      continue;
    }

    let usd = verdict.usd;
    let note: string | null = verdict.kind === "resize" ? verdict.reason : null;

    if (verdict.kind === "resize") {
      const originalImpact = impact;
      let measured: number | null = null;
      try {
        // Re-quote so the reported impact belongs to the size we will send,
        // rather than being extrapolated from the oversized probe.
        measured = await probe(jupiter, order, usd, request);
      } catch {
        note = `${verdict.reason} (impact estimated)`;
      }

      if (measured !== null) {
        const improved = measured < originalImpact * SPREAD_FLOOR_RATIO;

        if (!improved && verdict.cause === "impact") {
          // Cutting the size did not cut the rate, so this is a spread floor,
          // not a depth limit. Shrinking cannot make the trade cheaper per
          // dollar and would only skew the basket, so keep the intended size
          // and disclose the cost instead of hiding it in a tiny position.
          usd = order.usd;
          impact = originalImpact;
          note = `${(originalImpact * 100).toFixed(2)}% spread floor; smaller size does not reduce it`;
        } else {
          impact = measured;
          const recheck = judgeLeg(
            { symbol: order.symbol, usd, priceImpact: impact, liquidityUsd },
            limits,
          );
          if (recheck.kind === "defer") {
            deferred.push({ symbol: order.symbol, usd: order.usd, reason: recheck.reason });
            continue;
          }
          // A second resize request is honoured only for a hard depth cap. For
          // impact we stop here: the number reported is one we actually
          // measured, and a third quote would cost more rate limit than it is
          // worth.
          if (recheck.kind === "resize" && recheck.cause === "depth") usd = recheck.usd;
        }
      }
    }

    legs.push({
      order,
      usd,
      priceImpact: impact,
      transferFeeUsd: transferFeeCostUsd(usd, request.transferFeeBps),
      note,
    });
  }

  return summarize(legs, deferred);
}
