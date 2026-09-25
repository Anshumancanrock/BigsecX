/**
 * Asset routes: price and activity per company. Activity comes from the
 * issuer's undocumented `/api/stats` (cumulative volume by day, holders by
 * week). It is optional: when it fails, `activityAvailable` is false and the
 * activity fields are empty.
 */

import { Hono } from "hono";
import { UNIVERSE, basisLabel, bySymbol } from "@ps/core";
import {
  holderGrowth,
  holderSeries,
  latestDailyVolume,
  latestHolders,
  volumeSeries,
} from "@ps/market";
import type { Services } from "../context.ts";
import { requireInt } from "../lib/validate.ts";
import type { MarketSnapshot } from "@ps/market";

/** Issuer statistics, or null. The endpoint rate limits, and a failure should cost only the activity columns. */
async function tryStats(services: Services) {
  try {
    return await services.issuer.stats();
  } catch {
    return null;
  }
}

export function registerAssetRoutes(
  app: Hono,
  services: Services,
  market: () => Promise<MarketSnapshot>,
): void {
  /** Every asset with price, dislocation and activity. */
  app.get("/api/assets", async (c) => {
    const [snapshot, stats] = await Promise.all([market(), tryStats(services)]);

    const volume = stats ? latestDailyVolume(stats) : {};
    const holders = stats ? latestHolders(stats) : {};
    const growth = stats ? holderGrowth(stats) : {};

    return c.json({
      asOf: snapshot.takenAt.toISOString(),
      // Lets a client show an empty activity column as an upstream failure,
      // not as no trading.
      activityAvailable: stats !== null,
      assets: snapshot.tokens.map((t) => ({
        symbol: t.token.symbol,
        name: t.token.name,
        mint: t.token.mint,
        sectors: t.token.sectors,
        marketUsd: t.marketUsd,
        markUsd: t.markUsd,
        basis: t.basis,
        basisLabel: t.basisLabel,
        change24hPct: t.change24hPct,
        liquidityUsd: t.liquidityUsd,
        supplyUi: t.supplyUi,
        paused: t.paused,
        volumeUsd: volume[t.token.symbol] ?? null,
        holders: holders[t.token.symbol] ?? null,
        holderGrowth7d: growth[t.token.symbol] ?? null,
      })),
    });
  });

  /** One asset, with its history. */
  app.get("/api/assets/:symbol", async (c) => {
    const token = bySymbol(c.req.param("symbol"));
    if (!token) {
      return c.json({ error: "unknown symbol", known: UNIVERSE.map((t) => t.symbol) }, 404);
    }
    const days = requireInt(c.req.query("days"), "days", { min: 1, max: 400, fallback: 90 });
    const weeks = requireInt(c.req.query("weeks"), "weeks", { min: 1, max: 60, fallback: 52 });

    const [snapshot, stats] = await Promise.all([market(), tryStats(services)]);
    const view = snapshot.tokens.find((t) => t.token.symbol === token.symbol);
    if (!view) return c.json({ error: "no market data for this symbol" }, 503);

    return c.json({
      symbol: token.symbol,
      name: token.name,
      mint: token.mint,
      sectors: token.sectors,
      asOf: snapshot.takenAt.toISOString(),
      price: {
        marketUsd: view.marketUsd,
        markUsd: view.markUsd,
        basis: view.basis,
        basisLabel: basisLabel(view.basis),
        change24hPct: view.change24hPct,
      },
      supplyUi: view.supplyUi,
      liquidityUsd: view.liquidityUsd,
      multiplier: view.multiplier,
      transferFeeBps: view.transferFeeBps,
      paused: view.paused,
      issuerControl: view.issuerControl,
      activityAvailable: stats !== null,
      launchedAt: stats?.launchDates[token.symbol] ?? null,
      volume: stats ? volumeSeries(stats, token.symbol, days) : [],
      holders: stats ? holderSeries(stats, token.symbol, weeks) : [],
    });
  });
}
