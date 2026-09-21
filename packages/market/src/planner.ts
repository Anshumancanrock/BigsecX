/**
 * Turn a rebalance into an execution plan priced against live depth.
 *
 * The core module decides policy; this module pays for the information that
 * policy needs. Each leg is quoted at the size it would actually trade, judged
 * against depth and impact limits, and re-quoted once if it had to shrink.
 *
 * Cost is taken from the fill, not assembled from components. A mainnet
 * simulation established that Jupiter quotes NET of the Token-2022 transfer
 * fee, so the realized price already contains spread, impact and fee. Deriving
 * cost by comparing that price to a reference is both simpler and immune to
 * the double-counting an additive model invites.
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
  /** Quotable depth per symbol, from the price feed. */
  readonly liquidityUsdBySymbol: ReadonlyMap<string, number>;
  /** Reference price per UI share. Realized cost is measured against this. */
  readonly priceUsdBySymbol: ReadonlyMap<string, number>;
  /**
   * Active ScaledUiAmount multiplier per symbol. Quote amounts are raw base
   * units, so every conversion between shares and raw units needs this.
   * Getting it wrong sells five times too much SPACEX.
   */
  readonly scaleBySymbol: ReadonlyMap<string, number>;
  /** Transfer fee in force this epoch, for disclosure. */
  readonly transferFeeBps: number;
  readonly limits?: ExecutionLimits;
  /**
   * Route constraint, matched to the one the builder will use.
   *
   * Planning and building must price the same route or the cost shown is not
   * the cost paid. Measured at demo sizes the constraint costs at most
   * 0.003%, so matching it is free -- and it lets the builder reuse this
   * quote instead of taking a second one per leg.
   */
  readonly maxAccounts?: number;
}

interface Probe {
  readonly impact: number;
  /** Price per UI share the quote implies, all-in. */
  readonly effectivePriceUsd: number;
  /** Shares received, net of fee. Buys only; null for sells. */
  readonly outUi: number | null;
}

/** Quote one leg at one size and derive its realized price. */
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

  if (order.side === "buy") {
    quote = await jupiter.quote({
      inputMint: USDC_MINT,
      outputMint: token.mint,
      amount: BigInt(Math.round(usd * 10 ** USDC_DECIMALS)),
      ...(request.maxAccounts !== undefined ? { maxAccounts: request.maxAccounts } : {}),
    });
    // outAmount is raw and net of fee; scale it to UI shares before pricing.
    outUi = (Number(quote.outAmount) / 10 ** token.decimals) * multiplier;
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
    const proceedsUsd = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
    if (uiAmount <= 0) throw new Error(`planner: ${order.symbol} sell size is zero`);
    effectivePriceUsd = proceedsUsd / uiAmount;
  }

  return { impact: priceImpact(quote), effectivePriceUsd, outUi };
}

/**
 * Realized cost against the reference price, as a positive fraction.
 *
 * A buy above reference and a sell below it both cost the user, so the sign is
 * flipped for sells to keep "positive means worse".
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
  const legs: PlannedLeg[] = [];
  const deferred: { symbol: string; usd: number; reason: string }[] = [];

  for (const order of request.orders) {
    const liquidityUsd = request.liquidityUsdBySymbol.get(order.symbol) ?? 0;
    const reference = request.priceUsdBySymbol.get(order.symbol);

    let probe: Probe;
    try {
      probe = await probeLeg(jupiter, order, order.usd, request);
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
      { symbol: order.symbol, usd: order.usd, priceImpact: probe.impact, liquidityUsd },
      limits,
    );
    if (verdict.kind === "defer") {
      deferred.push({ symbol: order.symbol, usd: order.usd, reason: verdict.reason });
      continue;
    }

    let usd = verdict.usd;
    // The size the surviving probe was actually measured at. A depth recheck
    // can shrink `usd` again after the last quote, and the share count has to
    // be rescaled rather than reported at the stale size.
    let measuredAtUsd = order.usd;
    let note: string | null = verdict.kind === "resize" ? verdict.reason : null;

    if (verdict.kind === "resize") {
      const original = probe;
      let measured: Probe | null = null;
      try {
        // Re-quote so the reported numbers belong to the size we will send,
        // rather than being extrapolated from the oversized probe.
        measured = await probeLeg(jupiter, order, usd, request);
      } catch {
        note = `${verdict.reason} (impact estimated)`;
      }

      if (measured !== null) {
        const improved = measured.impact < original.impact * SPREAD_FLOOR_RATIO;

        if (!improved && verdict.cause === "impact") {
          // Cutting the size did not cut the rate, so this is a bid-ask spread
          // floor, not a depth limit. Shrinking cannot make the trade cheaper
          // per dollar and would only skew the basket, so keep the intended
          // size and disclose the cost instead of hiding it in a tiny position.
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
            deferred.push({ symbol: order.symbol, usd: order.usd, reason: recheck.reason });
            continue;
          }
          // A second resize is honoured only for a hard depth cap. For impact
          // we stop: the number reported is one we measured, and a third quote
          // costs more rate limit than it is worth.
          if (recheck.kind === "resize" && recheck.cause === "depth") usd = recheck.usd;
        }
      }
    }

    legs.push({
      order,
      usd,
      priceImpact: probe.impact,
      // Always a measured figure. If the leg moved after its last quote, the
      // quote was retaken above or the estimate was dropped entirely.
      expectedOutUi: measuredAtUsd === usd ? probe.outUi : null,
      effectivePriceUsd: probe.effectivePriceUsd,
      referencePriceUsd: reference ?? null,
      costVsReference: costVsReference(order.side, probe.effectivePriceUsd, reference),
      transferFeeUsd: transferFeeCostUsd(usd, request.transferFeeBps),
      note,
    });
  }

  return summarize(legs, deferred);
}
