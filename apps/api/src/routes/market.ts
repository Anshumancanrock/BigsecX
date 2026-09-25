import type { Hono } from "hono";
import { INDEX_DEFINITIONS, UNIVERSE, buildIndex, definitionById } from "@ps/core";
import { priceTruth, type MarketSnapshot } from "@ps/market";
import type { Services } from "../context.ts";
import type { SnapshotReader } from "../lib/market-cache.ts";
import { tokenMeta, type TokenMeta } from "../lib/meta.ts";
import { toMarketDto } from "../lib/serialize.ts";
import { indexInputs } from "../lib/snapshot.ts";

const DAY_MS = 24 * 60 * 60_000;

export function registerMarketRoutes(app: Hono, services: Services, market: SnapshotReader): void {
  const tokenFacts = services.tokenMeta ?? tokenMeta();

  app.get("/api/universe", (c) => c.json({ tokens: UNIVERSE }));

  app.get("/api/market", async (c) => {
    const snapshot = await market();
    // Directory metadata is optional: a failure leaves those fields empty and never costs the prices.
    const meta = await tokenFacts().catch(() => new Map<string, TokenMeta>());
    return c.json(toMarketDto(snapshot, change24h(services, snapshot), meta));
  });

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
        // A missing oracle column means no coverage or no key, never a price of zero.
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
}

/**
 * Change over the last day from recorded prices: the current market price
 * against the stored snapshot nearest 24 hours ago. Symbols without one keep
 * the aggregator's figure.
 */
function change24h(services: Services, snapshot: MarketSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  const then = services.store.marketPricesNear(snapshot.takenAt.getTime() - DAY_MS, 6 * 60 * 60_000);
  if (!then) return out;
  for (const t of snapshot.tokens) {
    const before = then.prices.get(t.token.symbol);
    if (t.marketUsd !== null && before && before > 0) out.set(t.token.symbol, (t.marketUsd / before - 1) * 100);
  }
  return out;
}
