import type { Hono } from "hono";
import type { MarketSnapshot } from "@ps/market";
import type { Services } from "../context.ts";
import { INTRADAY_HOURS, dayOf } from "../lib/price-history.ts";
import { requireInt } from "../lib/validate.ts";

export function intradayTable(
  closes: Record<string, Record<number, number>>,
  snapshot: MarketSnapshot,
  hours: number,
): { times: number[]; prices: Record<string, (number | null)[]> } {
  const now = snapshot.unixSeconds;
  const lastHour = Math.floor(now / 3600) * 3600;
  const times: number[] = [];
  for (let t = lastHour - (hours - 1) * 3600; t <= lastHour; t += 3600) times.push(t);
  if (now > lastHour) times.push(now);

  const prices: Record<string, (number | null)[]> = {};
  for (const token of snapshot.tokens) {
    const perHour = closes[token.token.symbol] ?? {};
    const multiplier = token.multiplier > 0 ? token.multiplier : 1;
    const known = Object.keys(perHour)
      .map(Number)
      .sort((a, b) => a - b);
    let k = 0;
    let last: number | null = null;
    while (k < known.length && known[k]! < times[0]!) last = perHour[known[k++]!]! / multiplier;
    prices[token.token.symbol] = times.map((t, i) => {
      while (k < known.length && known[k]! <= t) last = perHour[known[k++]!]! / multiplier;
      if (i === times.length - 1 && token.marketUsd !== null) return token.marketUsd;
      return last;
    });
    if (known.length === 0) prices[token.token.symbol] = times.map(() => null);
  }
  return { times, prices };
}

export function historyTable(
  closes: Record<string, Record<string, number>>,
  snapshot: MarketSnapshot,
  days: number,
): { days: string[]; prices: Record<string, (number | null)[]> } {
  const today = dayOf(snapshot.unixSeconds);
  const cutoff = dayOf(snapshot.unixSeconds - days * 86_400);
  const axis = new Set<string>();
  for (const perDay of Object.values(closes)) {
    for (const day of Object.keys(perDay)) if (day > cutoff && day <= today) axis.add(day);
  }
  if (axis.size === 0) return { days: [], prices: {} };
  axis.add(today);
  const sorted = [...axis].sort();

  const prices: Record<string, (number | null)[]> = {};
  for (const t of snapshot.tokens) {
    const perDay = closes[t.token.symbol] ?? {};
    const multiplier = t.multiplier > 0 ? t.multiplier : 1;
    prices[t.token.symbol] = sorted.map((day) => {
      if (day === today && t.marketUsd !== null) return t.marketUsd;
      const raw = perDay[day];
      return raw === undefined ? null : raw / multiplier;
    });
  }
  return { days: sorted, prices };
}

export function registerHistoryRoutes(
  app: Hono,
  services: Services,
  market: () => Promise<MarketSnapshot>,
): void {
  app.get("/api/history/intraday", async (c) => {
    const hours = requireInt(c.req.query("hours"), "hours", { min: 6, max: INTRADAY_HOURS, fallback: INTRADAY_HOURS });
    const history = services.history ?? null;
    history?.ensureHourlyFresh();
    const snapshot = await market();
    const table = intradayTable(history?.hourlyCloses() ?? {}, snapshot, hours);
    return c.json({
      asOf: snapshot.takenAt.toISOString(),
      complete: history !== null && history.hourlyFetchedAt !== null,
      source: "GeckoTerminal hourly candles from each company's busiest pool, divided by its current multiplier",
      ...table,
    });
  });

  /**
   * Daily prices for every company, oldest first. Served from cache without
   * waiting on the network; a cold cache answers `complete: false`.
   */
  app.get("/api/history", async (c) => {
    const days = requireInt(c.req.query("days"), "days", { min: 7, max: 365, fallback: 365 });
    const history = services.history ?? null;
    history?.ensureFresh();
    const snapshot = await market();
    const table = historyTable(history?.closes() ?? {}, snapshot, days);
    return c.json({
      asOf: snapshot.takenAt.toISOString(),
      complete: history !== null && history.fetchedAt !== null,
      refreshing: history?.refreshing ?? false,
      source: "GeckoTerminal daily candles, divided by each token's current multiplier",
      ...table,
    });
  });
}
