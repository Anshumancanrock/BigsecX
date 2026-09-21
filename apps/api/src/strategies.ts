/**
 * Strategy routes: the creator side of the product.
 *
 * Authoring is separated from the market and mirror routes because it is the
 * only part of the API that writes durable state a user owns. Ownership is
 * enforced on every mutation: a strategy id is public, so nothing may be
 * changed or removed on the strength of knowing one.
 *
 * Mutations require a signature from the wallet they claim. Asserting an
 * address was not merely unauthenticated, it was forgeable: anyone could
 * publish a basket attributed to any wallet, and on a product that ranks
 * traders by verified record, forged authorship destroys the record.
 */

import { Hono } from "hono";
import {
  StrategyInvalid,
  buildStrategy,
  combinedExposure,
  driftExceeded,
  sectorExposure,
  type Guardrails,
  type RebalanceFrequency,
  type Strategy,
  type Weight,
} from "@ps/core";
import type { StrategyRow } from "@ps/db";
import type { Services } from "./context.ts";
import { authorize, bodyDigest, canonicalMessage, signatureRequired } from "./auth.ts";
import { BadRequest, parseWeights, requireBase58Address, requireInt } from "./validate.ts";

const REBALANCE: readonly RebalanceFrequency[] = ["manual", "daily", "weekly", "monthly"];
/** Nothing legitimate overlaps more baskets than this. */
const MAX_OVERLAP_HOLDINGS = 32;

/**
 * Identify the caller and prove it.
 *
 * The signature is bound to the action and the resource, so one authorising
 * a create cannot be lifted onto a delete, and one for another strategy
 * cannot be replayed here.
 */
async function requireCreator(
  body: Record<string, unknown>,
  action: string,
  resource: string,
): Promise<string> {
  const wallet = requireBase58Address(body["creator"], "creator");
  await authorize(body, { action, resource, wallet });
  return wallet;
}

function toRow(strategy: Strategy): StrategyRow {
  return {
    id: strategy.id,
    kind: strategy.kind,
    name: strategy.name,
    description: strategy.description,
    creator: strategy.creator,
    rebalance: strategy.rebalance,
    maxWeight: strategy.guardrails.maxWeight,
    minWeight: strategy.guardrails.minWeight,
    maxSectorWeight: strategy.guardrails.maxSectorWeight ?? null,
    driftBps: strategy.guardrails.driftBps,
    published: strategy.published,
    createdAt: strategy.createdAt,
    updatedAt: strategy.updatedAt,
    weights: strategy.weights,
  };
}

function toDto(row: StrategyRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    creator: row.creator,
    rebalance: row.rebalance,
    published: row.published,
    guardrails: {
      maxWeight: row.maxWeight,
      minWeight: row.minWeight,
      maxSectorWeight: row.maxSectorWeight,
      driftBps: row.driftBps,
    },
    weights: row.weights,
    sectors: Object.fromEntries(sectorExposure(row.weights)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseGuardrails(value: unknown): Partial<Guardrails> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequest("guardrails must be an object");
  }
  const raw = value as Record<string, unknown>;
  const fraction = (key: string): number | undefined => {
    if (raw[key] === undefined || raw[key] === null) return undefined;
    const parsed = Number(raw[key]);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new BadRequest(`guardrails.${key} must be a fraction between 0 and 1`);
    }
    return parsed;
  };

  // Mutable while assembling; the domain takes it as readonly.
  const out: { -readonly [K in keyof Guardrails]?: Guardrails[K] } = {};
  const max = fraction("maxWeight");
  if (max !== undefined) out.maxWeight = max;
  const min = fraction("minWeight");
  if (min !== undefined) out.minWeight = min;
  const sector = fraction("maxSectorWeight");
  if (sector !== undefined) out.maxSectorWeight = sector;
  if (raw["driftBps"] !== undefined && raw["driftBps"] !== null) {
    out.driftBps = requireInt(raw["driftBps"], "guardrails.driftBps", {
      min: 0,
      max: 10_000,
      fallback: 300,
    });
  }
  return out;
}

function parseRebalance(value: unknown): RebalanceFrequency {
  if (value === undefined || value === null) return "manual";
  if (typeof value !== "string" || !REBALANCE.includes(value as RebalanceFrequency)) {
    throw new BadRequest(`rebalance must be one of ${REBALANCE.join(", ")}`);
  }
  return value as RebalanceFrequency;
}

/**
 * A url-safe id derived from the name, with a random suffix.
 *
 * Readable ids make shared links legible, and the suffix keeps two people
 * naming a basket "AI Index" from colliding.
 */
function strategyId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = crypto.randomUUID().slice(0, 8);
  return slug.length > 0 ? `${slug}-${suffix}` : suffix;
}

export function registerStrategyRoutes(app: Hono, services: Services): void {
  /**
   * The exact message a wallet must sign.
   *
   * A POST because the signature covers the request body, so deriving the
   * message needs that body. Served rather than documented: a client that
   * derived it even slightly differently would get an opaque verification
   * failure with nothing to debug.
   */
  app.post("/api/auth/message", async (c) => {
    const body = await readJson(c);
    const action = typeof body["action"] === "string" ? body["action"] : "";
    const resource = typeof body["resource"] === "string" ? body["resource"] : "";
    const wallet = requireBase58Address(body["wallet"], "wallet");
    if (!action) throw new BadRequest("action is required");

    const payload =
      body["body"] && typeof body["body"] === "object" && !Array.isArray(body["body"])
        ? (body["body"] as Record<string, unknown>)
        : {};

    const issuedAt = Date.now();
    return c.json({
      message: canonicalMessage({
        action,
        resource,
        wallet,
        issuedAt,
        bodyDigest: await bodyDigest(payload),
      }),
      issuedAt,
      required: signatureRequired(),
      note:
        "Sign these exact bytes, then send the request with signature (base64) and this issuedAt. " +
        "The body you sign must be the body you send, minus signature and issuedAt.",
    });
  });

  /**
   * Published strategies, optionally narrowed to one creator.
   *
   * Drafts are never returned here. A wallet address is public, so filtering
   * by creator cannot be what unlocks that wallet's unpublished work -- see
   * /api/strategies/mine, which requires a signature.
   */
  app.get("/api/strategies", (c) => {
    const creator = c.req.query("creator");
    const holding = c.req.query("holding");
    const limit = requireInt(c.req.query("limit"), "limit", { min: 1, max: 100, fallback: 50 });

    const rows = services.store.listStrategies({
      ...(creator ? { creator } : {}),
      ...(holding ? { holding } : {}),
      limit,
    });
    return c.json({ strategies: rows.map(toDto), scope: "published" });
  });

  /**
   * A creator's own strategies, drafts included.
   *
   * A POST because it carries a signature: reading your own unpublished work
   * requires proving the wallet is yours.
   */
  app.post("/api/strategies/mine", async (c) => {
    const body = await readJson(c);
    const creator = await requireCreator(body, "list-drafts", "mine");
    const limit = requireInt(body["limit"], "limit", { min: 1, max: 100, fallback: 50 });

    const rows = services.store.listStrategies({ creator, includeDrafts: true, limit });
    return c.json({ strategies: rows.map(toDto), scope: "creator" });
  });

  app.get("/api/strategies/:id", (c) => {
    const row = services.store.getStrategy(c.req.param("id"));
    if (!row) return c.json({ error: "unknown strategy" }, 404);
    return c.json(toDto(row));
  });

  app.post("/api/strategies", async (c) => {
    const body = await readJson(c);
    const creator = await requireCreator(body, "create-strategy", "new");

    // parseWeights rejects unknown symbols, duplicates and non-positive
    // values before the domain sees them, so the domain reports allocation
    // problems rather than typing mistakes.
    const constituents = parseWeights(body["weights"]);
    const name = typeof body["name"] === "string" ? body["name"] : "";
    const description = typeof body["description"] === "string" ? body["description"] : undefined;

    const guardrails = parseGuardrails(body["guardrails"]);

    let strategy: Strategy;
    try {
      strategy = buildStrategy(
        {
          name,
          creator,
          constituents,
          rebalance: parseRebalance(body["rebalance"]),
          ...(description !== undefined ? { description } : {}),
          ...(guardrails !== undefined ? { guardrails } : {}),
        },
        { id: strategyId(name), now: new Date(), published: body["published"] === true },
      );
    } catch (error) {
      // Every problem at once, so the author fixes them in one pass.
      if (error instanceof StrategyInvalid) return c.json({ error: error.message, problems: error.problems }, 400);
      throw error;
    }

    services.store.writeStrategy(toRow(strategy));
    // Respond with what persisted, not with what was about to be persisted.
    // Timestamps are stored to the second, so echoing the in-memory value
    // would give the caller a createdAt that changes on the next read.
    const saved = services.store.getStrategy(strategy.id);
    if (!saved) throw new Error(`strategy ${strategy.id} vanished after write`);
    return c.json(toDto(saved), 201);
  });

  /** Replace a strategy. Scoped to its creator. */
  app.put("/api/strategies/:id", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    const creator = await requireCreator(body, "update-strategy", id);

    const existing = services.store.getStrategy(id);
    if (!existing) return c.json({ error: "unknown strategy" }, 404);
    if (existing.creator !== creator) return c.json({ error: "not your strategy" }, 403);

    const constituents = parseWeights(body["weights"] ?? existing.weights);
    const name = typeof body["name"] === "string" ? body["name"] : existing.name;
    const description =
      typeof body["description"] === "string" ? body["description"] : existing.description;

    // Guardrails the caller omits keep the values already stored, so a rename
    // does not quietly drop the limits the author committed to.
    const guardrails = parseGuardrails(body["guardrails"]) ?? {
      maxWeight: existing.maxWeight,
      minWeight: existing.minWeight,
      driftBps: existing.driftBps,
      ...(existing.maxSectorWeight !== null ? { maxSectorWeight: existing.maxSectorWeight } : {}),
    };

    let strategy: Strategy;
    try {
      strategy = buildStrategy(
        {
          name,
          description,
          creator,
          constituents,
          guardrails,
          rebalance: parseRebalance(body["rebalance"] ?? existing.rebalance),
        },
        {
          id,
          now: new Date(),
          // An explicit boolean wins, so a creator can retract a basket.
          // Or-ing with the stored value made publication permanent.
          published: typeof body["published"] === "boolean" ? body["published"] : existing.published,
        },
      );
    } catch (error) {
      if (error instanceof StrategyInvalid) return c.json({ error: error.message, problems: error.problems }, 400);
      throw error;
    }

    // Creation time belongs to the original, not to this edit.
    services.store.writeStrategy({ ...toRow(strategy), createdAt: existing.createdAt });
    const saved = services.store.getStrategy(id);
    if (!saved) throw new Error(`strategy ${id} vanished after write`);
    return c.json(toDto(saved));
  });

  app.delete("/api/strategies/:id", async (c) => {
    const body = await readJson(c);
    const creator = await requireCreator(body, "delete-strategy", c.req.param("id"));

    const existing = services.store.getStrategy(c.req.param("id"));
    if (!existing) return c.json({ error: "unknown strategy" }, 404);
    if (existing.creator !== creator) return c.json({ error: "not your strategy" }, 403);

    services.store.deleteStrategy(c.req.param("id"), creator);
    return c.json({ deleted: c.req.param("id") });
  });

  /**
   * Combined exposure across several strategies.
   *
   * Thematic baskets share constituents, so someone holding three is usually
   * far more concentrated than they believe. This is the number that tells
   * them.
   */
  app.post("/api/strategies/overlap", async (c) => {
    const body = await readJson(c);
    const entries = body["holdings"];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new BadRequest("holdings must be a non-empty array of { strategyId, usd }");
    }
    // Each entry costs a database read, and nothing legitimate needs more
    // than a handful.
    if (entries.length > MAX_OVERLAP_HOLDINGS) {
      throw new BadRequest(`holdings must contain at most ${MAX_OVERLAP_HOLDINGS} entries`);
    }

    const resolved: { weights: readonly Weight[]; usd: number; id: string; name: string }[] = [];
    for (const entry of entries) {
      const { strategyId: id, usd } = (entry ?? {}) as { strategyId?: unknown; usd?: unknown };
      if (typeof id !== "string") throw new BadRequest("each holding needs a strategyId");
      const amount = Number(usd);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new BadRequest(`usd for ${id} must be a positive finite number`);
      }
      const row = services.store.getStrategy(id);
      if (!row) return c.json({ error: `unknown strategy ${id}` }, 404);
      resolved.push({ weights: row.weights, usd: amount, id: row.id, name: row.name });
    }

    const total = resolved.reduce((sum, r) => sum + r.usd, 0);
    const combined = combinedExposure(
      resolved.map((r) => ({ weights: r.weights, shareOfCapital: r.usd / total })),
    );

    return c.json({
      totalUsd: total,
      holdings: resolved.map((r) => ({ id: r.id, name: r.name, usd: r.usd })),
      exposure: combined.map((w) => ({ ...w, usd: w.weight * total })),
      sectors: Object.fromEntries(sectorExposure(combined)),
    });
  });

  /** Whether a wallet's actual weights have drifted from a strategy. */
  app.post("/api/strategies/:id/drift", async (c) => {
    const body = await readJson(c);
    const row = services.store.getStrategy(c.req.param("id"));
    if (!row) return c.json({ error: "unknown strategy" }, 404);

    const current = parseWeights(body["current"]);
    const total = current.reduce((sum, w) => sum + w.weight, 0);
    const normalized = current.map((w) => ({ symbol: w.symbol, weight: w.weight / total }));

    const result = driftExceeded(normalized, row.weights, row.driftBps);
    return c.json({
      strategy: row.id,
      driftBps: row.driftBps,
      exceeded: result.exceeded,
      worst: result.worst,
      target: row.weights,
      current: normalized,
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
