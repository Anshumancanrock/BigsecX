/**
 * Selling. Orders are sized from what the wallet holds on chain, then built by
 * the same pipeline as a purchase: depth resizing, refusal guards, per-leg
 * slippage and packing.
 */

import type { Hono } from "hono";
import type { RebalanceOrder } from "@ps/core";
import type { MarketSnapshot } from "@ps/market";
import type { Services } from "../context.ts";
import { buildFromOrders } from "../lib/builds.ts";
import { BadRequest, readJson, requireBase58Address, requireInt, toNumber } from "../lib/validate.ts";
import { readPortfolio } from "./portfolio.ts";

/**
 * Positions worth less than this are left alone. Below the $5 purchase minimum
 * so that a basket's smallest slice, worth a little under $5 after fees, can
 * still be sold; a sale opens no account and its fees are proportional.
 */
const MIN_SELL_USD = 1;

function parseSymbols(value: unknown, snapshot: MarketSnapshot): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new BadRequest("symbols must be an array");
  if (value.length === 0) throw new BadRequest("symbols must not be empty");
  if (value.length > 32) throw new BadRequest("symbols must contain at most 32 entries");

  const known = new Set(snapshot.tokens.map((t) => t.token.symbol));
  return value.map((raw) => {
    if (typeof raw !== "string") throw new BadRequest("each symbol must be a string");
    const upper = raw.toUpperCase();
    if (!known.has(upper)) throw new BadRequest(`unknown symbol ${JSON.stringify(raw)}`);
    return upper;
  });
}

function parseFraction(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const parsed = toNumber(value, "fraction");
  if (parsed <= 0 || parsed > 1) {
    throw new BadRequest("fraction must be greater than 0 and at most 1");
  }
  return parsed;
}

interface ExitPlan {
  readonly orders: RebalanceOrder[];
  readonly skipped: { symbol: string; usd: number; reason: string }[];
  readonly blocked: { symbol: string; reason: string }[];
  readonly proceedsUsd: number;
  readonly unpriced: string[];
}

/** Sell orders sized from the wallet's on-chain balances, never from amounts the caller supplies. */
async function planExit(
  services: Services,
  args: {
    readonly owner: string;
    readonly symbols: string[] | null;
    readonly fraction: number;
    readonly snapshot: MarketSnapshot;
  },
): Promise<ExitPlan> {
  const portfolio = await readPortfolio(services, args.owner, args.snapshot);

  const orders: RebalanceOrder[] = [];
  const skipped: { symbol: string; usd: number; reason: string }[] = [];
  const blocked: { symbol: string; reason: string }[] = [];
  const wanted = args.symbols ? new Set(args.symbols) : null;

  for (const position of portfolio.positions) {
    if (position.uiAmount <= 0) continue;
    if (wanted && !wanted.has(position.symbol)) continue;

    // Blocked (cannot be sold right now) is reported apart from skipped (too small).
    if (position.frozen) {
      blocked.push({ symbol: position.symbol, reason: "the issuer has frozen this account" });
      continue;
    }
    if (position.paused) {
      blocked.push({ symbol: position.symbol, reason: "the issuer has paused transfers of this token" });
      continue;
    }
    if (position.valueUsd === null) {
      blocked.push({ symbol: position.symbol, reason: "no price available, so it cannot be sized" });
      continue;
    }

    const usd = position.valueUsd * args.fraction;
    if (usd < MIN_SELL_USD) {
      skipped.push({
        symbol: position.symbol,
        usd,
        reason: `worth less than $${MIN_SELL_USD}, which is too small to sell`,
      });
      continue;
    }

    orders.push({
      symbol: position.symbol,
      side: "sell",
      usd,
      // Weights before and after, so the preview can show the move.
      fromWeight: position.weight ?? 0,
      toWeight: (position.weight ?? 0) * (1 - args.fraction),
    });
  }

  return {
    orders,
    skipped,
    blocked,
    proceedsUsd: orders.reduce((sum, o) => sum + o.usd, 0),
    unpriced: [...portfolio.unpriced],
  };
}

/** The 400 body when a wallet has nothing this request can sell. */
function nothingToSell(plan: ExitPlan) {
  return {
    error:
      plan.blocked.length > 0
        ? "nothing here can be sold right now"
        : "this wallet holds nothing worth selling",
    blocked: plan.blocked,
    skipped: plan.skipped,
    detail:
      plan.blocked.length > 0
        ? "Every position is frozen, paused, or has no price."
        : `Positions worth less than $${MIN_SELL_USD} are too small to sell.`,
  };
}

export function registerExitRoutes(
  app: Hono,
  services: Services,
  market: () => Promise<MarketSnapshot>,
): void {
  /** What selling would do, priced, without building anything to sign. */
  app.post("/api/exit/plan", async (c) => {
    const body = await readJson(c);
    const owner = requireBase58Address(body["owner"], "owner");
    const snapshot = await market();
    const plan = await planExit(services, {
      owner,
      symbols: parseSymbols(body["symbols"], snapshot),
      fraction: parseFraction(body["fraction"]),
      snapshot,
    });

    if (plan.orders.length === 0) return c.json(nothingToSell(plan), 400);

    return c.json({
      owner,
      sells: plan.orders.map((o) => ({ symbol: o.symbol, usd: o.usd })),
      proceedsUsd: plan.proceedsUsd,
      skipped: plan.skipped,
      blocked: plan.blocked,
      unpriced: plan.unpriced,
      note: "Proceeds arrive as USDC in this wallet. The final amount depends on the price when it lands.",
    });
  });

  /** Unsigned transactions that sell, with USDC coming back to the wallet. */
  app.post("/api/exit/build", async (c) => {
    const body = await readJson(c);
    const owner = requireBase58Address(body["owner"], "owner");
    const slippageBps = requireInt(body["slippageBps"], "slippageBps", {
      min: 1,
      max: 5_000,
      fallback: 150,
    });

    const snapshot = await market();
    const plan = await planExit(services, {
      owner,
      symbols: parseSymbols(body["symbols"], snapshot),
      fraction: parseFraction(body["fraction"]),
      snapshot,
    });

    if (plan.orders.length === 0) return c.json(nothingToSell(plan), 400);

    // No new capital: a sale has no buy legs, so the not-atomic guard has
    // nothing to refuse.
    const outcome = await buildFromOrders(services, {
      owner,
      orders: plan.orders,
      unpricedHoldings: plan.unpriced,
      deployUsd: 0,
      slippageBps,
      snapshot,
    });

    if (outcome.kind === "empty") {
      return c.json({ error: "nothing to sell", skipped: outcome.skipped }, 400);
    }
    if (outcome.kind === "refused") {
      return c.json({ error: outcome.problems[0]?.["message"], problems: outcome.problems }, 409);
    }
    if (outcome.bundle.transactions.length === 0) {
      return c.json(
        {
          error: "no part of this sale could be built",
          detail: "Every route was refused or could not be quoted; nothing is signable.",
          failed: outcome.bundle.failed,
        },
        502,
      );
    }

    return c.json({
      target: "Sell",
      targetSource: "exit",
      ...outcome.bundle,
      legs: outcome.orders,
      deferred: outcome.plan.deferred,
      totalUsd: outcome.plan.totalUsd,
      totalCostUsd: outcome.plan.totalCostUsd,
      costFraction: outcome.plan.costFraction,
      blocked: plan.blocked,
      skipped: plan.skipped,
      scope: "Sells the positions listed below. The proceeds arrive as USDC in this wallet.",
      atomic: false,
      note:
        "Sign all transactions together. They settle independently, so a partial sale is possible. " +
        "Submit promptly: the blockhash expires at the block height given here.",
    });
  });
}
