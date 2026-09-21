/**
 * Asset routes: everything known about one company.
 *
 * This is where the issuer's own statistics finally get used. PreStocks
 * publishes an undocumented `/api/stats` carrying 412 days of cumulative
 * volume and 60 weeks of holder counts per symbol -- the only long history
 * available for this market, and free. A market page without it shows price
 * and nothing about whether anyone is actually trading or holding.
 *
 * The series are reported as the issuer reports them, differenced into daily
 * figures, with the day in progress excluded from "latest" because a partial
 * day is not comparable with the full days beside it.
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
import type { Services } from "./context.ts";
import { requireInt } from "./validate.ts";
import type { MarketSnapshot } from "@ps/market";

/**
 * Issuer statistics, or nothing.
 *
 * The endpoint rate limits and is not essential to any price, so a failure
 * costs the activity columns and nothing else.
 */
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
      // Said plainly, so an empty activity column reads as an upstream
      // failure rather than as no trading.
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
