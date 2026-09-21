/**
 * The checks every signable bundle must pass, in one place.
 *
 * Mirroring an index and copying a trader end at the same point: a target
 * allocation, a wallet, and transactions to sign. The refusals are therefore
 * identical, and duplicating them per route guarantees they drift until one
 * path silently ships a bundle the other would have refused.
 *
 * Every applicable problem is returned, not the first. A wallet can be short
 * of stablecoin *and* be asking for a shape that cannot settle here; naming
 * one leaves the caller stuck on the next.
 */

import { planRebalance, slippageBpsFor, type ExecutionPlan, type Weight } from "@ps/core";
import { buildExecutionPlan } from "@ps/market";
import { buildMirrorBundle, findUncoveredSells, getSellableBalances, getSpendable } from "@ps/tx";
import type { Services } from "./context.ts";
import type { MarketSnapshot } from "@ps/market";

/** Enough lamports to submit several transactions and open accounts. */
export const MIN_LAMPORTS = 3_000_000;
/**
 * The route constraint the builder tries first.
 *
 * Planning matches it so both price the same route: a cost measured against
 * an unconstrained route is not the cost of the route that gets built.
 * Measured at demo sizes the constraint is worth at most 0.003%, so matching
 * it is free.
 */
const FIRST_RUNG_MAX_ACCOUNTS = 40;

export interface BuildRequest {
  readonly owner: string;
  readonly target: readonly Weight[];
  readonly deployUsd: number;
  readonly holdings: readonly { readonly symbol: string; readonly uiAmount: number }[];
  readonly slippageBps: number;
  readonly snapshot: MarketSnapshot;
}

export type BuildOutcome =
  | { readonly kind: "refused"; readonly problems: readonly Record<string, unknown>[] }
  | { readonly kind: "empty"; readonly skipped: unknown }
  | {
      readonly kind: "built";
      readonly bundle: Awaited<ReturnType<typeof buildMirrorBundle>>;
      readonly orders: readonly { readonly symbol: string; readonly side: string; readonly usd: number }[];
      /** The priced plan the bundle was built from. */
      readonly plan: ExecutionPlan;
    };

function priceMaps(snapshot: MarketSnapshot) {
  const price = new Map<string, number>();
  const liquidity = new Map<string, number>();
  const scale = new Map<string, number>();
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

export async function buildForTarget(
  services: Services,
  request: BuildRequest,
): Promise<BuildOutcome> {
  const { snapshot } = request;
  const { price, liquidity, scale, scaleConfig } = priceMaps(snapshot);

  const rebalance = planRebalance({
    target: request.target,
    holdings: request.holdings,
    priceUsdBySymbol: price,
    deployUsd: request.deployUsd,
  });
  if (rebalance.orders.length === 0) {
    return { kind: "empty", skipped: rebalance.skipped };
  }

  const problems: Record<string, unknown>[] = [];

  // A holding we could not price contributes nothing to portfolio value, so
  // the plan treats it as worthless and sizes every other leg against a
  // total that is too low.
  if (rebalance.unpricedHoldings.length > 0) {
    problems.push({
      kind: "unpriced-holding",
      message: "part of this wallet could not be valued",
      detail:
        "A holding with no available price is treated as worthless by the rebalancer, " +
        "which would size every other leg wrongly.",
      symbols: rebalance.unpricedHoldings,
    });
  }

  // A paused mint cannot be swapped at all.
  const pausedSymbols = new Set(snapshot.tokens.filter((t) => t.paused).map((t) => t.token.symbol));
  const pausedLegs = rebalance.orders.filter((o) => pausedSymbols.has(o.symbol));
  if (pausedLegs.length > 0) {
    problems.push({
      kind: "paused",
      message: "the issuer has halted transfers on part of this basket",
      detail: "Every swap touching a paused mint fails, so no bundle is built for it.",
      symbols: pausedLegs.map((o) => o.symbol),
    });
  }

  const sells = rebalance.orders.filter((o) => o.side === "sell");
  const buys = rebalance.orders.filter((o) => o.side === "buy");
  const buyNotional = buys.reduce((sum, o) => sum + o.usd, 0);

  if (sells.length > 0) {
    // New capital minus sales always equals the buy notional, so this is
    // reached whenever a rebalance both sells and buys. There is no
    // sell-and-buy shape that settles safely across separate transactions.
    if (buyNotional > request.deployUsd) {
      problems.push({
        kind: "not-atomic",
        message: "this rebalance funds buys from sells, which cannot be done atomically here",
        detail:
          `${buys.length} buy legs need $${buyNotional.toFixed(2)} but only ` +
          `$${request.deployUsd.toFixed(2)} of new capital was supplied. Execute the ` +
          `${sells.length} sell legs first, then request the buys.`,
        sells: sells.map((o) => ({ symbol: o.symbol, usd: o.usd })),
        buys: buys.map((o) => ({ symbol: o.symbol, usd: o.usd })),
      });
    }

    // Jupiter sells from the associated token account, so a sell sized
    // against a position held elsewhere fails on chain with 0x1788 after the
    // user has already signed.
    const balances = await getSellableBalances(
      services.rpc,
      request.owner,
      scaleConfig,
      snapshot.unixSeconds,
    );
    const uncovered = findUncoveredSells(rebalance.orders, balances, price);
    if (uncovered.length > 0) {
      problems.push({
        kind: "insufficient-balance",
        message: "wallet does not hold enough to cover these sell legs",
        detail:
          "Jupiter sells from the associated token account. Balances held in other " +
          "accounts are not spendable by this swap.",
        uncovered,
      });
    }
  }

  if (buys.length > 0) {
    const spendable = await getSpendable(services.rpc, request.owner);
    if (spendable.usdc + 1e-6 < buyNotional) {
      problems.push({
        kind: "insufficient-usdc",
        message: "wallet does not hold enough USDC to cover the buy legs",
        detail: "Buys are quoted from the associated USDC account.",
        requiredUsd: buyNotional,
        availableUsd: spendable.usdc,
      });
    }
    if (spendable.lamports < MIN_LAMPORTS) {
      problems.push({
        kind: "insufficient-sol",
        message: "wallet does not hold enough SOL to pay transaction fees",
        detail: `At least ${MIN_LAMPORTS / 1e9} SOL is needed to submit and open accounts.`,
        lamports: spendable.lamports,
      });
    }
  }

  if (problems.length > 0) return { kind: "refused", problems };

  // Price the plan against live depth, and build from THAT.
  //
  // This step used to be missing here: the planning endpoint resized legs
  // for depth and impact and deferred the ones the pools could not absorb,
  // and the build endpoint then sent the raw unresized orders. A user saw
  // "NEURALINK reduced to $30, KALSHI deferred" and signed a bundle doing
  // neither. The whole execution policy existed only in the preview.
  const plan = await buildExecutionPlan(services.jupiter, {
    orders: rebalance.orders,
    liquidityUsdBySymbol: liquidity,
    priceUsdBySymbol: price,
    scaleBySymbol: scale,
    transferFeeBps: snapshot.tokens[0]?.transferFeeBps ?? 0,
    // Matched to the builder's first rung so its quotes can be reused.
    maxAccounts: FIRST_RUNG_MAX_ACCOUNTS,
  });

  if (plan.legs.length === 0) {
    return {
      kind: "refused",
      problems: [
        {
          kind: "no-executable-legs",
          message: "no leg of this basket can be executed at this size",
          detail: "Every leg exceeded its depth or impact limit against current liquidity.",
          deferred: plan.deferred,
        },
      ],
    };
  }

  // "confirmed", not "finalized". A blockhash lives about 150 blocks and a
  // finalized one is already ~32 blocks old when handed out, spending part
  // of the user's signing window before they see the prompt.
  const { value } = await services.rpc.call<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>("getLatestBlockhash", [{ commitment: "confirmed" }]);

  // Each leg carries a tolerance derived from the impact it just measured.
  // The caller's value is a floor, not a ceiling: it says how much room the
  // user is comfortable with at minimum, and a pool that demonstrably needs
  // more gets more rather than reverting after they have signed.
  const legs = plan.legs.map((l) => ({
    symbol: l.order.symbol,
    side: l.order.side,
    usd: l.usd,
    slippageBps: slippageBpsFor(l.priceImpact, { floorBps: request.slippageBps }),
  }));

  const bundle = await buildMirrorBundle(services.jupiter, {
    owner: request.owner,
    legs,
    priceUsdBySymbol: price,
    scaleBySymbol: scale,
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
    slippageBps: request.slippageBps,
  });

  return { kind: "built", bundle, orders: legs, plan };
}
