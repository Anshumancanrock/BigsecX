/**
 * HTTP API.
 *
 * Read endpoints serve the latest market view, the indexes and the
 * leaderboard. Write endpoints do not write anything on chain: they return
 * unsigned transactions for a wallet to sign. Nothing here holds a key.
 *
 * The app is built by a factory taking its services as an argument, rather
 * than reaching for module-level singletons. That is what makes the routes
 * testable: a test can hand in a fake chain and a fake aggregator and exercise
 * every branch without a network, which hand-fuzzing a running server cannot
 * do for error paths.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  INDEX_DEFINITIONS,
  UNIVERSE,
  buildIndex,
  buildLeaderboard,
  definitionById,
  planRebalance,
  type IndexInput,
  type TradeRecord,
  type Weight,
} from "@ps/core";
import { Cache, buildExecutionPlan, priceTruth } from "@ps/market";
import { takeSnapshot } from "@ps/indexer/snapshot.ts";
import type { Services } from "./context.ts";
import { toMarketDto } from "./serialize.ts";
import { buildForTarget } from "./build-guards.ts";
import { registerCopyRoutes } from "./copy.ts";
import { registerPortfolioRoutes } from "./portfolio.ts";
import { registerStrategyRoutes } from "./strategies.ts";
import { registerTraderRoutes } from "./traders.ts";
import {
  BadRequest,
  parseHoldings,
  parseWeights,
  requireBase58Address,
  requireFiniteUsd,
  requireInt,
} from "./validate.ts";

const MARKET_TTL_MS = 20_000;
/** How long a snapshot may be served after expiry when upstreams are failing. */
const MARKET_STALE_MS = 10 * 60_000;

export function createApp(services: Services): Hono {
const app = new Hono();

app.use("/*", cors());

registerStrategyRoutes(app, services);
registerPortfolioRoutes(app, services, market);
registerTraderRoutes(app, services, market);
registerCopyRoutes(app, services, market);

app.onError((error, c) => {
  // A malformed request is the caller's to fix and gets a 400 with the
  // reason. Anything else is ours, and the client learns nothing useful from
  // our stack trace.
  if (error instanceof BadRequest) return c.json({ error: error.message }, 400);
  console.error("request failed:", error);
  return c.json({ error: "internal error" }, 500);
});

/**
 * Cached market view.
 *
 * Uses the shared Cache rather than a bare timestamp so concurrent requests
 * collapse into one snapshot instead of each triggering their own, and so an
 * upstream 429 -- which both the issuer API and Jupiter return readily --
 * serves the last good snapshot rather than failing the request. During a
 * demo a slightly old price beats an error page.
 *
 * Scoped to the app instance so tests do not leak a snapshot between cases.
 */
const marketCache = new Cache(4);

function market() {
  return marketCache.fetch(
    "snapshot",
    MARKET_TTL_MS,
    () => takeSnapshot(services.rpc, services.jupiter),
    MARKET_STALE_MS,
  );
}

function indexInputs(snapshot: Awaited<ReturnType<typeof takeSnapshot>>): IndexInput[] {
  return snapshot.tokens.map((t) => ({
    symbol: t.token.symbol,
    sectors: t.token.sectors,
    impliedValuationUsd: t.marketUsd === null ? null : t.marketUsd * t.supplyUi,
    liquidityUsd: t.liquidityUsd,
    basis: t.basis,
    paused: t.paused,
  }));
}

function priceMaps(snapshot: Awaited<ReturnType<typeof takeSnapshot>>) {
  const price = new Map<string, number>();
  const liquidity = new Map<string, number>();
  const scale = new Map<string, number>();
  // The snapshot resolves the active multiplier already, so hand the balance
  // reader a config that simply reports it rather than re-deriving from an
  // effective timestamp.
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

app.get("/health", (c) => c.json({ ok: true }));

app.get("/api/universe", (c) => c.json({ tokens: UNIVERSE }));

app.get("/api/market", async (c) => c.json(toMarketDto(await market())));

/**
 * Price Truth: a token against every reference available for it.
 *
 * PreStocks publishes a mark, but that is the issuer valuing its own SPV.
 * Pyth publishes a price for the same companies from an unrelated source, so
 * where it has coverage the token can be judged against something the issuer
 * does not control. Where the two references disagree, that spread is itself
 * the finding.
 */
app.get("/api/price-truth", async (c) => {
  const snapshot = await market();
  const oracle = await services.pyth.prices(snapshot.tokens.map((t) => t.token.symbol));
  const now = new Date();

  const rows = snapshot.tokens.map((t) =>
    priceTruth({
      symbol: t.token.symbol,
      marketUsd: t.marketUsd,
      markUsd: t.markUsd,
      oracle: oracle.get(t.token.symbol),
      now,
    }),
  );

  return c.json({
    asOf: snapshot.takenAt.toISOString(),
    oracle: {
      source: "pyth",
      available: services.pyth.available,
      covered: [...oracle.keys()].sort(),
      // Stated rather than implied: a missing oracle column is coverage or
      // configuration, not a price of zero.
      note: services.pyth.available
        ? "Pyth carries a 24/7 reference for a subset of these companies."
        : "No PYTH_API_KEY configured; Hermes rejects price reads without one, so only the issuer mark is available.",
    },
    tokens: rows,
  });
});

app.get("/api/indexes", async (c) => {
  const snapshot = await market();
  const inputs = indexInputs(snapshot);

  const indexes = INDEX_DEFINITIONS.map((definition) => {
    const portfolio = buildIndex(definition, inputs);
    const history = services.store.indexHistory(definition.id, 200);
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      scheme: definition.scheme.kind,
      // Null rather than an empty basket: a liquidity floor can legitimately
      // select nothing, and that is a state worth showing.
      weights: portfolio?.weights ?? null,
      level: history.at(-1)?.level ?? null,
    };
  });
  return c.json({ takenAt: snapshot.takenAt.toISOString(), indexes });
});

app.get("/api/indexes/:id", async (c) => {
  const definition = definitionById(c.req.param("id"));
  if (!definition) return c.json({ error: "unknown index" }, 404);

  const snapshot = await market();
  const portfolio = buildIndex(definition, indexInputs(snapshot));
  const history = services.store.indexHistory(definition.id, 500);

  return c.json({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    scheme: definition.scheme,
    weights: portfolio?.weights ?? null,
    history: history.map((h) => ({ at: h.takenAt.toISOString(), level: h.level })),
  });
});

/**
 * Leaderboard of traders, reconstructed from indexed swaps.
 *
 * Ranks by profit measured against cost basis observed on chain, not by change
 * in portfolio value: the latter rewards funding a wallet rather than trading
 * it well. Wallets whose cost basis is incomplete -- those that sold a
 * position acquired before indexing began -- are excluded, because their
 * apparent profit is an artefact of when we started watching.
 *
 * Both limits are returned in the response rather than left implicit.
 */
app.get("/api/leaderboard", async (c) => {
  const hours = requireInt(c.req.query("hours"), "hours", { min: 1, max: 24 * 30, fallback: 24 });
  const limit = requireInt(c.req.query("limit"), "limit", { min: 1, max: 100, fallback: 25 });
  const sortBy = ((): "pnl" | "return" | "volume" => {
    const raw = c.req.query("sortBy");
    return raw === "return" || raw === "volume" ? raw : "pnl";
  })();

  const latestSlot = services.store.latestTradeSlot();
  if (latestSlot === null) {
    return c.json({ window: `${hours}h`, entries: [], note: "no trades indexed yet" });
  }

  // Slots are produced at roughly 2.5 per second on mainnet. Using slots
  // rather than block time keeps this working when block_time is null, which
  // it can be for older entries.
  const sinceSlot = Math.max(0, latestSlot - Math.round((hours * 3_600) / 0.4));
  const byOwner = services.store.tradesByOwnerSince(sinceSlot);

  const snapshot = await market();
  const prices = new Map<string, number>();
  for (const t of snapshot.tokens) {
    if (t.marketUsd !== null) prices.set(t.token.symbol, t.marketUsd);
  }

  const records = new Map<string, TradeRecord[]>();
  for (const [owner, trades] of byOwner) {
    records.set(
      owner,
      trades.map((t) => ({
        owner,
        symbol: t.symbol,
        uiAmount: t.uiAmount,
        valueUsd: t.valueUsd,
        slot: t.slot,
      })),
    );
  }

  // Exposed because the right floor depends on how much history has been
  // indexed. With a thin dataset a $100 default hides every wallet.
  const minVolumeUsd = requireInt(c.req.query("minVolumeUsd"), "minVolumeUsd", {
    min: 0,
    max: 1_000_000,
    fallback: 100,
  });
  const board = buildLeaderboard(records, prices, { limit, sortBy, minVolumeUsd });

  return c.json({
    window: `${hours}h`,
    sortBy,
    minVolumeUsd,
    sinceSlot,
    walletsConsidered: records.size,
    entries: board.map((row) => ({
      owner: row.owner,
      trades: row.trades,
      volumeUsd: row.volumeUsd,
      peakInvestedUsd: row.peakInvestedUsd,
      markValueUsd: row.markValueUsd,
      pnlUsd: row.pnlUsd,
      returnFraction: row.returnFraction,
      positions: row.positions,
    })),
    caveats: [
      "Profit is measured only over trades indexed since this deployment started watching.",
      "Wallets that sold a position acquired before indexing began are excluded, because their cost basis is unknown.",
      "Open positions are marked at the current DEX price, not at a price anyone was filled at.",
    ],
  });
});

/** Resolve a mirror target: either a named index or explicit weights. */
async function resolveTarget(body: {
  indexId?: unknown;
  weights?: unknown;
}): Promise<{ weights: readonly Weight[]; name: string }> {
  if (body.weights !== undefined) {
    return { weights: parseWeights(body.weights), name: "custom" };
  }
  if (typeof body.indexId !== "string") {
    throw new BadRequest("provide indexId or weights");
  }

  const definition = definitionById(body.indexId);
  if (!definition) throw new BadRequest(`unknown index ${body.indexId}`);

  const portfolio = buildIndex(definition, indexInputs(await market()));
  if (!portfolio) {
    throw new BadRequest(`index ${body.indexId} currently has no tradable constituents`);
  }
  return { weights: portfolio.weights, name: definition.name };
}

/**
 * Price a mirror without building transactions.
 *
 * Separate from /build on purpose: a user should see what a basket costs, and
 * which legs the pools cannot absorb, before a wallet ever opens.
 */
app.post("/api/mirror/plan", async (c) => {
  const body = await safeJson(c);
  const target = await resolveTarget(body);
  const deployUsd = requireFiniteUsd(body.deployUsd ?? 0, "deployUsd");
  const holdings = parseHoldings(body.holdings);
  if (deployUsd === 0 && holdings.length === 0) {
    throw new BadRequest("provide deployUsd, holdings, or both");
  }

  const snapshot = await market();
  const { price, liquidity, scale } = priceMaps(snapshot);

  const rebalance = planRebalance({
    target: target.weights,
    holdings,
    priceUsdBySymbol: price,
    deployUsd,
  });

  const plan = await buildExecutionPlan(services.jupiter, {
    orders: rebalance.orders,
    liquidityUsdBySymbol: liquidity,
    priceUsdBySymbol: price,
    scaleBySymbol: scale,
    transferFeeBps: snapshot.tokens[0]?.transferFeeBps ?? 0,
  });

  return c.json({
    target: target.name,
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
 * Build unsigned transactions for a mirror.
 *
 * Returns base64 versioned transactions for `signAllTransactions`. The basket
 * is several transactions, so it is not atomic; the response says how the legs
 * were grouped so a client can report a partial fill honestly.
 */
app.post("/api/mirror/build", async (c) => {
  const body = await safeJson(c);
  const owner = requireBase58Address(body["owner"], "owner");
  const target = await resolveTarget(body);
  const deployUsd = requireFiniteUsd(body["deployUsd"] ?? 0, "deployUsd");
  const holdings = parseHoldings(body["holdings"]);
  const slippageBps = requireInt(body["slippageBps"], "slippageBps", {
    min: 1,
    max: 5_000,
    fallback: 100,
  });

  const outcome = await buildForTarget(services, {
    owner,
    target: target.weights,
    deployUsd,
    holdings,
    slippageBps,
    snapshot: await market(),
  });

  if (outcome.kind === "empty") {
    return c.json({ error: "nothing to trade", skipped: outcome.skipped }, 400);
  }
  if (outcome.kind === "refused") {
    return c.json({ error: outcome.problems[0]?.["message"], problems: outcome.problems }, 409);
  }

  // Every leg failing is not a success with nothing in it.
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
    ...outcome.bundle,
    // The sizes actually built, after depth and impact limits. These are
    // what the transactions do, and they are what the plan endpoint shows.
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

return app;
}

/** Parse a JSON body, turning malformed JSON into a 400 rather than a 500. */
async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
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


