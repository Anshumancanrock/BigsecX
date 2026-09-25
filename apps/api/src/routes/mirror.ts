import type { Hono } from "hono";
import { UNIVERSE, buildIndex, definitionById, planRebalance, type Weight } from "@ps/core";
import { buildExecutionPlan } from "@ps/market";
import type { Services } from "../context.ts";
import { publicStrategy } from "../lib/access.ts";
import { buildForTarget, landingFees } from "../lib/builds.ts";
import type { SnapshotReader } from "../lib/market-cache.ts";
import { indexInputs, priceMaps } from "../lib/snapshot.ts";
import {
  BadRequest,
  parseHoldings,
  parseWeights,
  readJson,
  requireBase58Address,
  requireFiniteUsd,
  requireInt,
} from "../lib/validate.ts";
import { readPortfolio } from "./portfolio.ts";

/** Buying a target: a system index, a published strategy, or inline weights. */
export function registerMirrorRoutes(app: Hono, services: Services, tradingMarket: SnapshotReader): void {
  /**
   * Prices a mirror without building transactions, so the cost and any legs
   * the pools cannot absorb are visible before a wallet opens.
   */
  app.post("/api/mirror/plan", async (c) => {
    const body = await readJson(c);
    const target = await resolveTarget(services, tradingMarket, body);
    const deployUsd = requireFiniteUsd(body["deployUsd"] ?? 0, "deployUsd");

    const mode = parseMirrorMode(body["mode"]);

    const snapshot = await tradingMarket();
    // Only a rebalance looks at holdings. With an owner they are read from
    // chain so the plan matches the build; without one, supplied holdings are
    // the premise of a hypothetical.
    const owner = body["owner"] === undefined ? null : requireBase58Address(body["owner"], "owner");
    const holdings =
      mode === "add"
        ? []
        : owner
          ? (await readPortfolio(services, owner, snapshot)).positions.map((p) => ({
              symbol: p.symbol,
              uiAmount: p.uiAmount,
            }))
          : parseHoldings(body["holdings"]);

    if (mode === "add" && deployUsd === 0) {
      throw new BadRequest("provide deployUsd: the amount to spend");
    }
    if (deployUsd === 0 && holdings.length === 0) {
      throw new BadRequest("provide deployUsd, holdings, or both");
    }
    const { price, liquidity, scale } = priceMaps(snapshot);

    const rebalance = planRebalance({
      target: target.weights,
      holdings,
      priceUsdBySymbol: price,
      deployUsd,
    });

    // Priced with the fee the build will allow for, so the preview matches it.
    const feeFor = await landingFees(services, snapshot);
    const plan = await buildExecutionPlan(services.jupiter, {
      orders: rebalance.orders,
      liquidityUsdBySymbol: liquidity,
      priceUsdBySymbol: price,
      scaleBySymbol: scale,
      transferFeeBps: Math.max(0, ...rebalance.orders.map((o) => feeFor(o.symbol))),
    });

    return c.json({
      target: target.name,
      targetSource: target.source,
      mode,
      weights: target.weights,
      skipped: rebalance.skipped,
      unpricedHoldings: rebalance.unpricedHoldings,
      legs: plan.legs.map((l) => ({
        symbol: l.order.symbol,
        side: l.order.side,
        usd: l.usd,
        expectedOutUi: l.expectedOutUi,
        effectivePriceUsd: l.effectivePriceUsd,
        referencePriceUsd: l.referencePriceUsd,
        costVsReference: l.costVsReference,
        priceImpact: l.priceImpact,
        transferFeeUsd: l.transferFeeUsd,
        note: l.note,
      })),
      deferred: plan.deferred,
      totalUsd: plan.totalUsd,
      totalCostUsd: plan.totalCostUsd,
      costFraction: plan.costFraction,
      transferFeeBps: snapshot.tokens[0]?.transferFeeBps ?? 0,
      pendingFeeChange: snapshot.pendingFeeChange,
    });
  });

  /**
   * Builds unsigned versioned transactions for `signAllTransactions`. A
   * basket spans several transactions that settle independently, so the
   * response says how the legs were grouped and a partial fill is reportable.
   */
  app.post("/api/mirror/build", async (c) => {
    const body = await readJson(c);
    const owner = requireBase58Address(body["owner"], "owner");
    const target = await resolveTarget(services, tradingMarket, body);
    const deployUsd = requireFiniteUsd(body["deployUsd"] ?? 0, "deployUsd");
    // A floor: each leg widens it to suit the pool it trades in.
    const slippageBps = requireInt(body["slippageBps"], "slippageBps", {
      min: 1,
      max: 5_000,
      fallback: 150,
    });

    const mode = parseMirrorMode(body["mode"]);
    if (mode === "add" && deployUsd === 0) {
      throw new BadRequest("provide deployUsd: the amount to spend");
    }

    const snapshot = await tradingMarket();
    // A rebalance sizes every leg from holdings, so they are read from chain
    // and never taken from the request.
    const holdings =
      mode === "rebalance"
        ? (await readPortfolio(services, owner, snapshot)).positions.map((p) => ({
            symbol: p.symbol,
            uiAmount: p.uiAmount,
          }))
        : [];

    const outcome = await buildForTarget(services, {
      owner,
      target: target.weights,
      deployUsd,
      holdings,
      slippageBps,
      snapshot,
    });

    if (outcome.kind === "empty") {
      return c.json({ error: "nothing to trade", skipped: outcome.skipped }, 400);
    }
    if (outcome.kind === "refused") {
      return c.json({ error: outcome.problems[0]?.["message"], problems: outcome.problems }, 409);
    }
    if (outcome.bundle.transactions.length === 0) {
      return c.json(
        {
          error: "no leg of this basket could be built",
          detail: "Every route was refused or could not be quoted; nothing is signable.",
          failed: outcome.bundle.failed,
        },
        502,
      );
    }

    return c.json({
      target: target.name,
      targetSource: target.source,
      mode,
      ...outcome.bundle,
      // The sizes actually built, after depth and impact limits.
      legs: outcome.orders,
      deferred: outcome.plan.deferred,
      totalUsd: outcome.plan.totalUsd,
      totalCostUsd: outcome.plan.totalCostUsd,
      costFraction: outcome.plan.costFraction,
      atomic: false,
      note:
        "Sign all transactions together. They settle independently, so a partial fill is possible. " +
        "Submit promptly: the blockhash expires at the block height given here.",
    });
  });
}

/**
 * What a mirror does with the wallet's existing holdings. "add" spends new
 * money on the target and sells nothing; it is what every buy button means.
 * "rebalance" moves the whole wallet toward the target and must be asked for.
 */
function parseMirrorMode(value: unknown): "add" | "rebalance" {
  if (value === undefined || value === null) return "add";
  if (value === "add" || value === "rebalance") return value;
  throw new BadRequest('mode must be "add" or "rebalance"');
}

/** Only published strategies resolve: a draft is private to its author, and its id is not a secret. */
async function resolveTarget(
  services: Services,
  tradingMarket: SnapshotReader,
  body: { indexId?: unknown; strategyId?: unknown; weights?: unknown },
): Promise<{ weights: readonly Weight[]; name: string; source: string }> {
  if (body.weights !== undefined) {
    const weights = parseWeights(body.weights);
    const only = weights.length === 1 ? UNIVERSE.find((t) => t.symbol === weights[0]!.symbol) : undefined;
    return { weights, name: only?.name ?? "Your mix", source: "weights" };
  }

  if (typeof body.strategyId === "string") {
    const strategy = publicStrategy(services.store, body.strategyId);
    if (!strategy) {
      throw new BadRequest(
        `unknown strategy ${body.strategyId}, or it is still a draft; publish it before it can be bought`,
      );
    }
    return { weights: strategy.weights, name: strategy.name, source: "strategy" };
  }

  if (typeof body.indexId !== "string") {
    throw new BadRequest("provide indexId, strategyId or weights");
  }

  const definition = definitionById(body.indexId);
  if (!definition) throw new BadRequest(`unknown index ${body.indexId}`);

  const portfolio = buildIndex(definition, indexInputs(await tradingMarket()));
  if (!portfolio) {
    throw new BadRequest(`index ${body.indexId} currently has no tradable constituents`);
  }
  return { weights: portfolio.weights, name: definition.name, source: "index" };
}
