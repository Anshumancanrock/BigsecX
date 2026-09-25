import {
  landingFeeBps,
  planRebalance,
  slippageBpsFor,
  type ExecutionPlan,
  type RebalanceOrder,
  type Weight,
} from "@ps/core";
import { buildExecutionPlan } from "@ps/market";
import { buildMirrorBundle, findUncoveredSells, getSellableBalances, getSpendable } from "@ps/tx";
import type { Services } from "../context.ts";
import type { MarketSnapshot } from "@ps/market";
import { priceMaps } from "./snapshot.ts";

/** Enough lamports to submit several transactions. */
export const MIN_LAMPORTS = 3_000_000;

/**
 * Rent deposit for one new PreStocks token account, rounded up. A 191-byte
 * Token-2022 associated account holds 2,020,227 lamports.
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_250_000;
/**
 * The builder's first route constraint. Planning uses the same one so the plan
 * prices the route that gets built; at typical order sizes it costs at most 0.003%.
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
      readonly plan: ExecutionPlan;
    };

/**
 * The transfer fee each leg will pay when it lands: the fee in force, or the
 * scheduled one near the end of the epoch (see landingFeeBps). The epoch is
 * read only while a change is pending.
 */
export async function landingFees(
  services: Services,
  snapshot: MarketSnapshot,
): Promise<(symbol: string) => number> {
  const pending = snapshot.pendingFeeChange;
  let clock: { epoch: number; slotsLeft: number } | null = null;
  if (pending) {
    try {
      const info = await services.rpc.call<{ epoch: number; slotIndex: number; slotsInEpoch: number }>(
        "getEpochInfo",
        [{ commitment: "confirmed" }],
      );
      const slotsLeft = info.slotsInEpoch - info.slotIndex;
      // A reply without a usable position is treated as no reply.
      if (Number.isFinite(info.epoch) && Number.isFinite(slotsLeft)) clock = { epoch: info.epoch, slotsLeft };
    } catch {
      // Position unknown: landingFeeBps then assumes the higher fee.
    }
  }
  const inForce = new Map(snapshot.tokens.map((t) => [t.token.symbol, t.transferFeeBps]));
  const highest = Math.max(0, ...inForce.values());
  return (symbol) => landingFeeBps(inForce.get(symbol) ?? highest, pending, clock);
}

export async function buildForTarget(
  services: Services,
  request: BuildRequest,
): Promise<BuildOutcome> {
  const { snapshot } = request;
  const { price } = priceMaps(snapshot);

  const rebalance = planRebalance({
    target: request.target,
    holdings: request.holdings,
    priceUsdBySymbol: price,
    deployUsd: request.deployUsd,
    minTicketUsd: MIN_TICKET_USD,
  });
  if (rebalance.orders.length === 0) {
    return { kind: "empty", skipped: rebalance.skipped };
  }

  const outcome = await buildFromOrders(services, {
    owner: request.owner,
    orders: rebalance.orders,
    unpricedHoldings: rebalance.unpricedHoldings,
    deployUsd: request.deployUsd,
    slippageBps: request.slippageBps,
    snapshot,
  });
  if (outcome.kind !== "built") return outcome;

  const tooSmall = rebalance.skipped
    .filter((s) => s.reason === "below minimum ticket")
    .map((s) => ({
      symbol: s.symbol,
      usd: s.usd,
      reason: `only ${formatUsd(s.usd)} of this at this size — under the ${formatUsd(MIN_TICKET_USD)} minimum, where fees would cost more than it is worth`,
    }));
  if (tooSmall.length === 0) return outcome;
  return { ...outcome, plan: { ...outcome.plan, deferred: [...outcome.plan.deferred, ...tooSmall] } };
}

const MIN_TICKET_USD = 5;

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export async function buildFromOrders(
  services: Services,
  request: {
    readonly owner: string;
    readonly orders: readonly RebalanceOrder[];
    readonly unpricedHoldings: readonly string[];
    readonly deployUsd: number;
    readonly slippageBps: number;
    readonly snapshot: MarketSnapshot;
  },
): Promise<BuildOutcome> {
  const { snapshot } = request;
  const { price, liquidity, scale, scaleConfig } = priceMaps(snapshot);
  const rebalance = { orders: request.orders, unpricedHoldings: request.unpricedHoldings };

  const problems: Record<string, unknown>[] = [];

  // An unpriced holding counts as worthless, so every other leg would be sized
  // against too low a total.
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

  const balances = await getSellableBalances(
    services.rpc,
    request.owner,
    scaleConfig,
    snapshot.unixSeconds,
  );

  if (sells.length > 0) {
    // A rebalance that sells funds its buys partly from the sale, so this fires
    // whenever it both sells and buys: separate transactions cannot make that safe.
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

    // Jupiter sells from the associated token account, so a sell sized against
    // a position held elsewhere fails on chain (0x1788) after signing.
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

  // SOL is checked for every order, sells included; USDC only when something is bought.
  const spendable = await getSpendable(services.rpc, request.owner);

  if (buys.length > 0 && spendable.usdc + 1e-6 < buyNotional) {
    problems.push({
      kind: "insufficient-usdc",
      message: "wallet does not hold enough USDC to cover the buy legs",
      detail: "Buys are quoted from the associated USDC account.",
      requiredUsd: buyNotional,
      availableUsd: spendable.usdc,
    });
  }

  const newAccounts = new Set(buys.filter((o) => !balances.get(o.symbol)?.exists).map((o) => o.symbol)).size;
  const requiredLamports = MIN_LAMPORTS + newAccounts * TOKEN_ACCOUNT_RENT_LAMPORTS;
  if (spendable.lamports < requiredLamports) {
    problems.push({
      kind: "insufficient-sol",
      message: "wallet does not hold enough SOL to pay transaction fees",
      detail:
        newAccounts > 0
          ? `About ${(requiredLamports / 1e9).toFixed(4)} SOL is needed: network fees, plus a refundable ` +
            `deposit for each of the ${newAccounts} token account${newAccounts === 1 ? "" : "s"} this opens.`
          : `At least ${MIN_LAMPORTS / 1e9} SOL is needed to submit.`,
      lamports: spendable.lamports,
      requiredLamports,
      newAccounts,
    });
  }

  if (problems.length > 0) return { kind: "refused", problems };

  // Build from the plan priced against live depth, so the bundle matches the preview.
  const feeFor = await landingFees(services, snapshot);
  const plan = await buildExecutionPlan(services.jupiter, {
    orders: rebalance.orders,
    liquidityUsdBySymbol: liquidity,
    priceUsdBySymbol: price,
    scaleBySymbol: scale,
    transferFeeBps: Math.max(0, ...rebalance.orders.map((o) => feeFor(o.symbol))),
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

  // "confirmed": a blockhash lives about 150 blocks, and a finalized one is
  // already ~32 old, which shortens the user's signing window.
  const { value } = await services.rpc.call<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>("getLatestBlockhash", [{ commitment: "confirmed" }]);

  // Each leg's tolerance comes from its measured impact, with the caller's value
  // as a floor. The transfer fee goes on top: some pools' quotes do not net it,
  // and it would otherwise use up most of a sale's room before the price moved.
  const legs = plan.legs.map((l) => {
    const mark = price.get(l.order.symbol);
    const feeBps = feeFor(l.order.symbol);
    return {
      symbol: l.order.symbol,
      side: l.order.side,
      usd: l.usd,
      slippageBps: slippageBpsFor(l.priceImpact, { floorBps: request.slippageBps }) + feeBps,
      // The fee's share of the tolerance, so the review can show how far the
      // price itself may move.
      feeAllowanceBps: feeBps,
      ...(l.order.side === "buy" && l.expectedOutUi !== null ? { expectedShares: l.expectedOutUi } : {}),
      ...(l.order.side === "sell" && l.effectivePriceUsd !== null && mark
        ? { expectedUsd: (l.usd / mark) * l.effectivePriceUsd }
        : {}),
    };
  });

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
