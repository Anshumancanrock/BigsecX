/**
 * Copy routes.
 *
 * Copying mirrors a leader's current allocation, not their last transaction.
 * A leader spending $700 out of a $100,000 book moved 0.7% of their
 * portfolio; a follower with $1,000 copying the dollar amount would move 70%
 * of theirs. Weights make the relationship proportional at any size.
 *
 * Nothing is custodial. A preview computes target weights, a build returns
 * unsigned transactions, and the follower signs. Stopping needs no on-chain
 * action, because no standing authority was ever granted -- which is also
 * why there is no "stop" endpoint here: there is nothing to revoke.
 */

import { Hono } from "hono";
import {
  CopyLimitsInvalid,
  previewCopy,
  stopLossTriggered,
  type CopyLimits,
  type Weight,
} from "@ps/core";
import type { Services } from "./context.ts";
import { readPortfolio } from "./portfolio.ts";
import { buildForTarget } from "./build-guards.ts";
import { BadRequest, requireBase58Address, requireFiniteUsd, requireInt } from "./validate.ts";

/** Matches the ceiling the copy domain enforces, against ~$2.6M of depth. */
const MAX_COPY_CAPITAL_USD = 1_000_000;
import type { MarketSnapshot } from "@ps/indexer/snapshot.ts";

function parseLimits(body: Record<string, unknown>): CopyLimits {
  const fraction = (key: string, fallback: number): number => {
    if (body[key] === undefined || body[key] === null) return fallback;
    const parsed = Number(body[key]);
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
    // Checked against the copy ceiling here rather than the generic deploy
    // ceiling, so an oversized request is refused at the edge with one
    // message instead of passing validation and failing later with another.
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

/** The leader's live allocation, which is what a follower is copying. */
async function leaderWeights(
  services: Services,
  leader: string,
  snapshot: MarketSnapshot,
): Promise<{ readonly weights: Weight[]; readonly totalUsd: number; readonly unpriced: string[] }> {
  const portfolio = await readPortfolio(services, leader, snapshot);
  return { weights: portfolio.weights, totalUsd: portfolio.totalUsd, unpriced: portfolio.unpriced };
}

export function registerCopyRoutes(
  app: Hono,
  services: Services,
  market: () => Promise<MarketSnapshot>,
): void {
  /**
   * What a follower would hold if they started copying now.
   *
   * Read-only and cheap, so it can be shown before a wallet is even
   * connected. Every dropped position is named with its reason; a preview
   * that quietly omits part of the leader's book is worse than no preview.
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

  /**
   * Unsigned transactions that move a follower onto a leader's allocation.
   *
   * Runs the same refusals as every other build, so a copy cannot ship a
   * bundle that mirroring an index would have rejected.
   */
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

    // Deliberately no holdings.
    //
    // Copying with $1,000 deploys $1,000 into the leader's allocation. It is
    // not a rebalance of everything the follower owns. Passing their existing
    // positions here made planRebalance target (existing + capital), so a
    // follower holding $5,000 elsewhere saw a preview promising $600 and
    // $400 and got a bundle selling $5,000 of an untouched position and
    // buying $3,600 and $2,400 -- six times the size, liquidating a holding
    // they never agreed to sell, after they had already approved the
    // preview.
    //
    // With no holdings, planRebalance produces exactly weight x deployUsd per
    // leg, which is the preview by construction rather than by coincidence.
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
      // What the transactions actually do, after depth and impact limits.
      legs: outcome.orders,
      deferred: outcome.plan.deferred,
      totalUsd: outcome.plan.totalUsd,
      costFraction: outcome.plan.costFraction,
      // Stated because it is the one thing a follower could reasonably get
      // wrong: this adds a sleeve, it does not rebalance the whole wallet.
      scope: "Deploys the stated capital into the leader's allocation. Existing holdings are left untouched.",
      ...outcome.bundle,
      atomic: false,
      note:
        "Sign all transactions together. They settle independently, so a partial fill is possible. " +
        "Submit promptly: the blockhash expires at the block height given here.",
    });
  });

  /**
   * Whether a follower's drawdown has reached their stop.
   *
   * Stateless: the caller supplies the peak and current values it has been
   * tracking. Keeping the running peak server-side would mean holding an
   * authoritative record of somebody's balance, which this service
   * deliberately does not do.
   */
  app.post("/api/copy/stop-check", async (c) => {
    const body = await readJson(c);
    const peakValueUsd = requireFiniteUsd(body["peakValueUsd"], "peakValueUsd", { min: 0 });
    const currentValueUsd = requireFiniteUsd(body["currentValueUsd"], "currentValueUsd", { min: 0 });

    const stopLossRaw = body["stopLossFraction"];
    let stopLossFraction: number | undefined;
    if (stopLossRaw !== undefined && stopLossRaw !== null) {
      const parsed = Number(stopLossRaw);
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

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequest("body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
