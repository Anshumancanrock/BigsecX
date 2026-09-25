/**
 * The market snapshot polled by AppShell, for components that need it
 * without prop drilling (for example company names in trade sheets).
 */

import { createContext, useContext } from "react";
import type { Market } from "./api.ts";

export const MarketContext = createContext<Market | null>(null);

export function useMarket(): Market | null {
  return useContext(MarketContext);
}

export function useCompanyName(): (symbol: string) => string {
  const market = useMarket();
  return (symbol) => market?.tokens.find((t) => t.symbol === symbol)?.name ?? symbol;
}
