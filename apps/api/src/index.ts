/**
 * HTTP API.
 *
 * Read endpoints serve the latest market view, the indexes and the
 * leaderboard. Write endpoints do not write anything on chain: they return
 * unsigned transactions for a wallet to sign. Nothing here holds a key.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  INDEX_DEFINITIONS,
  UNIVERSE,
  buildIndex,
  computePerformance,
  definitionById,
  planRebalance,
  rankWallets,
  type IndexInput,
  type RankedWallet,
  type Weight,
} from "@ps/core";
import { buildExecutionPlan } from "@ps/market";
import { buildMirrorBundle } from "@ps/tx";
import { takeSnapshot } from "@ps/indexer/snapshot.ts";
import { createServices } from "./context.ts";
import { toMarketDto } from "./serialize.ts";

const services = createServices();
const app = new Hono();

app.use("/*", cors());

app.onError((error, c) => {
  // Upstreams fail in ways a client can do nothing about; say so plainly
  // rather than leaking a stack trace.
  console.error("request failed:", error);
  return c.json({ error: error.message }, 500);
});

/** Cached market view. Snapshots are expensive and change slowly. */
let cached: { snapshot: Awaited<ReturnType<typeof takeSnapshot>>; at: number } | null = null;
const MARKET_TTL_MS = 20_000;

async function market() {
  if (cached && Date.now() - cached.at < MARKET_TTL_MS) return cached.snapshot;
  const snapshot = await takeSnapshot(services.rpc, services.jupiter);
  cached = { snapshot, at: Date.now() };
  return snapshot;
}

function indexInputs(snapshot: Awaited<ReturnType<typeof takeSnapshot>>): IndexInput[] {
  return snapshot.tokens.map((t) => ({
    symbol: t.token.symbol,
    sectors: t.token.sectors,
    impliedValuationUsd: t.marketUsd === null ? null : t.marketUsd * t.supplyUi,
    liquidityUsd: t.liquidityUsd,
    basis: t.basis,
  }));
}

function priceMaps(snapshot: Awaited<ReturnType<typeof takeSnapshot>>) {
  const price = new Map<string, number>();
  const liquidity = new Map<string, number>();
  const scale = new Map<string, number>();
  for (const t of snapshot.tokens) {
    if (t.marketUsd !== null) price.set(t.token.symbol, t.marketUsd);
    liquidity.set(t.token.symbol, t.liquidityUsd);
    scale.set(t.token.symbol, t.multiplier);
  }
  return { price, liquidity, scale };
}

app.get("/health", (c) => c.json({ ok: true }));

app.get("/api/universe", (c) => c.json({ tokens: UNIVERSE }));

app.get("/api/market", async (c) => c.json(toMarketDto(await market())));

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
 * Leaderboard over a trailing window.
 *
 * Ranks the largest observable holders by flow-adjusted return. Two limits are
 * stated in the response rather than buried: only the top accounts per mint
 * are indexed, and return is measured on holdings, not on realised profit.
 */
app.get("/api/leaderboard", (c) => {
  const windowHours = Number(c.req.query("hours") ?? 24);
  const latest = services.store.latestSnapshot();
  if (!latest) return c.json({ error: "no snapshots yet" }, 503);

  const earlier = services.store.snapshotAtOrBefore(
    new Date(latest.takenAt.getTime() - windowHours * 3_600_000),
  );
  if (!earlier || earlier.id === latest.id) {
    return c.json({
      window: `${windowHours}h`,
      entries: [],
      note: "not enough history yet for this window",
    });
  }

  const before = services.store.positionsAt(earlier.id);
  const after = services.store.positionsAt(latest.id);
  const priceBefore = priceRowsFor(earlier.id);
  const priceAfter = priceRowsFor(latest.id);

  const byOwner = new Map<string, { before: typeof before; after: typeof after }>();
  for (const row of before) {
    const entry = byOwner.get(row.owner) ?? { before: [], after: [] };
    entry.before.push(row);
    byOwner.set(row.owner, entry);
  }
  for (const row of after) {
    const entry = byOwner.get(row.owner) ?? { before: [], after: [] };
    entry.after.push(row);
    byOwner.set(row.owner, entry);
  }

  const wallets: RankedWallet[] = [...byOwner.entries()].map(([owner, sides]) => ({
    owner,
    positions: sides.after.map((p) => ({ symbol: p.symbol, uiAmount: p.uiAmount })),
    performance: computePerformance({
      before: sides.before.map((p) => ({ symbol: p.symbol, uiAmount: p.uiAmount })),
      after: sides.after.map((p) => ({ symbol: p.symbol, uiAmount: p.uiAmount })),
      priceBefore,
      priceAfter,
    }),
  }));

  return c.json({
    window: `${windowHours}h`,
    from: earlier.takenAt.toISOString(),
    to: latest.takenAt.toISOString(),
    entries: rankWallets(wallets, { limit: Number(c.req.query("limit") ?? 25) }).map((w) => ({
      owner: w.owner,
      returnFraction: w.performance.returnFraction,
      valueUsd: w.performance.valueAfter,
      netFlowUsd: w.performance.netFlowUsd,
      positions: w.positions,
    })),
    caveats: [
      "Ranks the largest observable accounts per token, not every holder.",
      "Return is measured on holdings and adjusted for deposits and withdrawals; it is not realised profit and loss.",
    ],
  });
});

function priceRowsFor(snapshotId: number): Map<string, number> {
  const rows = services.store.raw
    .query("SELECT symbol, market_usd AS marketUsd FROM token_price WHERE snapshot_id = ?")
    .all(snapshotId) as { symbol: string; marketUsd: number | null }[];
  const prices = new Map<string, number>();
  for (const row of rows) if (row.marketUsd !== null) prices.set(row.symbol, row.marketUsd);
  return prices;
}

/** Resolve a mirror target: either a named index or explicit weights. */
async function resolveTarget(body: {
  indexId?: string;
  weights?: Weight[];
}): Promise<{ weights: readonly Weight[]; name: string } | null> {
  if (body.weights?.length) return { weights: body.weights, name: "custom" };
  if (!body.indexId) return null;

  const definition = definitionById(body.indexId);
  if (!definition) return null;
  const portfolio = buildIndex(definition, indexInputs(await market()));
  return portfolio ? { weights: portfolio.weights, name: definition.name } : null;
}

/**
 * Price a mirror without building transactions.
 *
 * Separate from /build on purpose: a user should see what a basket costs, and
 * which legs the pools cannot absorb, before a wallet ever opens.
 */
app.post("/api/mirror/plan", async (c) => {
  const body = await c.req.json();
  const target = await resolveTarget(body);
  if (!target) return c.json({ error: "provide indexId or weights" }, 400);

  const snapshot = await market();
  const { price, liquidity, scale } = priceMaps(snapshot);

  const rebalance = planRebalance({
    target: target.weights,
    holdings: body.holdings ?? [],
    priceUsdBySymbol: price,
    deployUsd: Number(body.deployUsd ?? 0),
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
  const body = await c.req.json();
  if (typeof body.owner !== "string") return c.json({ error: "owner is required" }, 400);

  const target = await resolveTarget(body);
  if (!target) return c.json({ error: "provide indexId or weights" }, 400);

  const snapshot = await market();
  const { price, scale } = priceMaps(snapshot);

  const rebalance = planRebalance({
    target: target.weights,
    holdings: body.holdings ?? [],
    priceUsdBySymbol: price,
    deployUsd: Number(body.deployUsd ?? 0),
  });
  if (rebalance.orders.length === 0) {
    return c.json({ error: "nothing to trade", skipped: rebalance.skipped }, 400);
  }

  const { value } = await services.rpc.call<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>("getLatestBlockhash", [{ commitment: "finalized" }]);

  const bundle = await buildMirrorBundle(services.jupiter, {
    owner: body.owner,
    legs: rebalance.orders.map((o) => ({ symbol: o.symbol, side: o.side, usd: o.usd })),
    priceUsdBySymbol: price,
    scaleBySymbol: scale,
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
    slippageBps: Number(body.slippageBps ?? 100),
  });

  return c.json({
    target: target.name,
    ...bundle,
    atomic: false,
    note: "Sign all transactions together. They settle independently, so a partial fill is possible.",
  });
});

const port = Number(process.env["PORT"] ?? 3000);
console.log(`API listening on http://localhost:${port}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
