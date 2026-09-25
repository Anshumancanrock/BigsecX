/** Service handles, built once at startup so client caches and rate limits persist across requests. */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_RPC_URLS, Rpc } from "@ps/chain";
import { JupiterClient, PreStocksClient, PythClient } from "@ps/market";
import { Store } from "@ps/db";
import { PriceHistory, geckoTerminal } from "./lib/price-history.ts";
import type { TokenMeta } from "./lib/meta.ts";

export interface Services {
  readonly rpc: Rpc;
  readonly jupiter: JupiterClient;
  readonly issuer: PreStocksClient;
  readonly pyth: PythClient;
  readonly store: Store;
  /** Daily prices for the dashboard chart. Absent in tests unless supplied. */
  readonly history?: PriceHistory;
  /** Logos, holders and volume from the token directory. Tests supply a fake. */
  readonly tokenMeta?: () => Promise<Map<string, TokenMeta>>;
}

/** Next to the database, so one data directory holds everything cached. */
function historyCachePath(): string {
  const database = process.env["DATABASE_PATH"];
  if (database) return join(dirname(database), "price-history.json");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(root, "data", "price-history.json");
}

export function createServices(): Services {
  return {
    rpc: new Rpc({
      // One endpoint or several, comma-separated; the public pair by default,
      // so either can drop out without taking prices and balances with it.
      url: process.env["SOLANA_RPC_URL"] ?? PUBLIC_RPC_URLS,
      // A request waits on every call, so a silent node gets 15 seconds
      // before the next one is asked.
      timeoutMs: 15_000,
    }),
    jupiter: new JupiterClient(),
    issuer: new PreStocksClient(),
    pyth: new PythClient(),
    store: new Store(),
    history: new PriceHistory(geckoTerminal(), historyCachePath()),
  };
}
