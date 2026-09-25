/**
 * Copy routes. A follower copies the leader's current allocation by weight,
 * so the copy is proportional at any size. Builds return unsigned
 * transactions, and stopping needs no endpoint because no authority is granted.
 */

import { Hono } from "hono";
import {
  CopyLimitsInvalid,
  previewCopy,
  stopLossTriggered,
  type CopyLimits,
  type Weight,
} from "@ps/core";
import type { MarketSnapshot } from "@ps/market";
import type { Services } from "../context.ts";
import { buildForTarget } from "../lib/builds.ts";
import { BadRequest, readJson, requireBase58Address, requireFiniteUsd, requireInt, toNumber } from "../lib/validate.ts";
import { readPortfolio } from "./portfolio.ts";

const MAX_COPY_CAPITAL_USD = 1_000_000;

function parseLimits(body: Record<string, unknown>): CopyLimits {
  const fraction = (key: string, fallback: number): number => {
    if (body[key] === undefined || body[key] === null) return fallback;
    const parsed = toNumber(body[key], key);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      throw new BadRequest(`${key} must be a fraction between 0 and 1`);
    }
    return parsed;
  };

  const excludeSymbols = body["excludeSymbols"];
  if (excludeSymbols !== undefined && !Array.isArray(excludeSymbols)) {
    throw new BadRequest("excludeSymbols must be an array");
  }

  const stopLossRaw = body["stopLossFraction"];
  const limits: CopyLimits = {
    // The copy ceiling rather than the generic deploy ceiling, so an oversized
    // copy is refused here with one clear message.
    capitalUsd: requireFiniteUsd(body["capitalUsd"], "capitalUsd", {
      min: 1,
      max: MAX_COPY_CAPITAL_USD,
    }),
    copyRatio: fraction("copyRatio", 1),
    maxPositionWeight: fraction("maxPositionWeight", 1),
    maxSlippageBps: requireInt(body["maxSlippageBps"], "maxSlippageBps", {
      min: 1,
      max: 5_000,
      fallback: 150,
    }),
    ...(excludeSymbols !== undefined
      ? { excludeSymbols: (excludeSymbols as unknown[]).map((s) => String(s)) }
      : {}),
    ...(stopLossRaw !== undefined && stopLossRaw !== null
      ? { stopLossFraction: fraction("stopLossFraction", 0.15) }
      : {}),
  };
  return limits;
}

async function leaderWeights(
  services: Services,
  leader: string,
  snapshot: MarketSnapshot,
): Promise<{ readonly weights: Weight[]; readonly totalUsd: number; readonly unpriced: string[] }> {
  const portfolio = await readPortfolio(services, leader, snapshot, { includeStranded: true });

  const usdBySymbol = new Map<string, number>();
  for (const p of portfolio.positions) {
    if (p.valueUsd !== null) usdBySymbol.set(p.symbol, (usdBySymbol.get(p.symbol) ?? 0) + p.valueUsd);
  }
  for (const e of portfolio.elsewhere) {
    if (e.valueUsd !== null) usdBySymbol.set(e.symbol, (usdBySymbol.get(e.symbol) ?? 0) + e.valueUsd);
  }

  const totalUsd = [...usdBySymbol.values()].reduce((sum, v) => sum + v, 0);
  const weights =
    totalUsd > 0
      ? [...usdBySymbol].map(([symbol, usd]) => ({ symbol, weight: usd / totalUsd }))
      : [];
  return { weights, totalUsd, unpriced: portfolio.unpriced };
}

export function registerCopyRoutes(
  app: Hono,
  services: Services,
  market: () => Promise<MarketSnapshot>,
): void {
  /**
   * What a follower would hold if they started copying now. Read-only; every
   * position left out is named with its reason.
   */
  app.post("/api/copy/preview", async (c) => {
    const body = await readJson(c);
    const leader = requireBase58Address(body["leader"], "leader");

    let limits: CopyLimits;
    try {
      limits = parseLimits(body);
    } catch (error) {
      if (error instanceof CopyLimitsInvalid) {
        return c.json({ error: error.message, problems: error.problems }, 400);
      }
      throw error;
    }

    const snapshot = await market();
    const leaderBook = await leaderWeights(services, leader, snapshot);

    if (leaderBook.weights.length === 0) {
      return c.json({
        leader,
        deployUsd: 0,
        reserveUsd: limits.capitalUsd,
        positions: [],
        excluded: [],
        notes: ["This wallet holds none of the tradable universe, so there is nothing to copy."],
        leaderValueUsd: leaderBook.totalUsd,
      });
    }

    let preview;
    try {
      preview = previewCopy({
        leader,
        leaderWeights: leaderBook.weights,
        limits,
        pausedSymbols: snapshot.tokens.filter((t) => t.paused).map((t) => t.token.symbol),
      });
    } catch (error) {
      if (error instanceof CopyLimitsInvalid) {
        return c.json({ error: error.message, problems: error.problems }, 400);
      }
      throw error;
    }

    return c.json({
      ...preview,
      leaderValueUsd: leaderBook.totalUsd,
      // Named so a follower knows the leader's book is only partly visible.
      leaderUnpriced: leaderBook.unpriced,
      asOf: snapshot.takenAt.toISOString(),
      custody:
        "Non-custodial. This returns target weights; you sign the trades yourself and can stop at any time without an on-chain action.",
    });
  });

  app.post("/api/copy/build", async (c) => {
    const body = await readJson(c);
    const leader = requireBase58Address(body["leader"], "leader");
    const follower = requireBase58Address(body["follower"], "follower");
    if (leader === follower) {
      return c.json({ error: "a wallet cannot copy itself" }, 400);
    }

    const limits = parseLimits(body);
    const snapshot = await market();
    const leaderBook = await leaderWeights(services, leader, snapshot);
    if (leaderBook.weights.length === 0) {
      return c.json({ error: "this leader holds nothing that can be copied" }, 409);
    }

    const preview = previewCopy({
      leader,
      leaderWeights: leaderBook.weights,
      limits,
      pausedSymbols: snapshot.tokens.filter((t) => t.paused).map((t) => t.token.symbol),
    });
    if (preview.targetWeights.length === 0) {
      return c.json(
        { error: "nothing of this leader's portfolio can be copied under these limits", notes: preview.notes },
        409,
      );
    }

    // No holdings: a copy deploys new capital into the leader's allocation and
    // never rebalances the rest of the wallet. With none, planRebalance yields
    // exactly weight x deployUsd per leg, which is what the preview shows.
    const outcome = await buildForTarget(services, {
      owner: follower,
      target: preview.targetWeights,
      deployUsd: preview.deployUsd,
      holdings: [],
      slippageBps: limits.maxSlippageBps,
      snapshot,
    });

    if (outcome.kind === "empty") {
      return c.json({ error: "nothing to trade at this size", skipped: outcome.skipped }, 400);
    }
    if (outcome.kind === "refused") {
      return c.json({ error: outcome.problems[0]?.["message"], problems: outcome.problems }, 409);
    }
    if (outcome.bundle.transactions.length === 0) {
      return c.json(
        {
          error: "no leg of this copy could be built",
          detail: "Every route was refused or could not be quoted; nothing is signable.",
          failed: outcome.bundle.failed,
        },
        502,
      );
    }

    return c.json({
      leader,
      follower,
      preview: { positions: preview.positions, excluded: preview.excluded, notes: preview.notes },
      legs: outcome.orders,
      deferred: outcome.plan.deferred,
      totalUsd: outcome.plan.totalUsd,
      costFraction: outcome.plan.costFraction,
      // Stated explicitly: a copy adds to the wallet and never rebalances it.
      scope: "Buys the mix this trader holds right now, with the amount you chose. Nothing you already own is sold.",
      ...outcome.bundle,
      atomic: false,
      note:
        "Sign all transactions together. They settle independently, so a partial fill is possible. " +
        "Submit promptly: the blockhash expires at the block height given here.",
    });
  });

  /**
   * Whether a follower's drawdown has reached their stop. Stateless: the
   * caller tracks the peak, so the server keeps no record of anyone's balance.
   */
  app.post("/api/copy/stop-check", async (c) => {
    const body = await readJson(c);
    const peakValueUsd = requireFiniteUsd(body["peakValueUsd"], "peakValueUsd", { min: 0 });
    const currentValueUsd = requireFiniteUsd(body["currentValueUsd"], "currentValueUsd", { min: 0 });

    const stopLossRaw = body["stopLossFraction"];
    let stopLossFraction: number | undefined;
    if (stopLossRaw !== undefined && stopLossRaw !== null) {
      const parsed = toNumber(stopLossRaw, "stopLossFraction");
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
        throw new BadRequest("stopLossFraction must be a fraction between 0 and 1");
      }
      stopLossFraction = parsed;
    }

    const result = stopLossTriggered({ peakValueUsd, currentValueUsd, stopLossFraction });
    return c.json({
      ...result,
      stopLossFraction: stopLossFraction ?? null,
      action: result.triggered
        ? "Stop copying. No on-chain action is needed; simply stop signing further mirrors."
        : "Continue.",
    });
  });
}
