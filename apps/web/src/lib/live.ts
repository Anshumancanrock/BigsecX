/**
 * Replaces the last point of each price series with the live market price.
 * History is fetched every few minutes and the market every few seconds, so
 * without this a chart's right edge lags the price shown above it. Returns the
 * same object when nothing changed, so memoised charts skip the redraw.
 */

import { useMemo } from "react";
import type { Market } from "./api.ts";

type PriceTable = { readonly prices: Readonly<Record<string, readonly (number | null)[]>> };

export function withLivePrices<T extends PriceTable>(table: T | null, market: Market | null): T | null {
  if (!table || !market) return table;
  let prices: Record<string, readonly (number | null)[]> | null = null;
  for (const token of market.tokens) {
    const series = table.prices[token.symbol];
    const live = token.marketUsd;
    if (!series || series.length === 0 || live === null || !Number.isFinite(live)) continue;
    if (series[series.length - 1] === live) continue;
    prices ??= { ...table.prices };
    prices[token.symbol] = [...series.slice(0, -1), live];
  }
  return prices ? { ...table, prices } : table;
}

/**
 * Hook form of `withLivePrices`, keyed on the prices rather than on the
 * market object, which is new on every poll.
 */
export function useLivePrices<T extends PriceTable>(table: T | null, market: Market | null): T | null {
  const key = market ? market.tokens.map((t) => `${t.symbol}:${t.marketUsd}`).join("|") : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => withLivePrices(table, market), [table, key]);
}
