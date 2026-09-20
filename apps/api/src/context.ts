/**
 * Shared service handles.
 *
 * Built once at startup so the caches inside the market clients survive across
 * requests. Constructing a client per request would defeat the rate limiting
 * they exist to provide.
 */

import { Rpc } from "@ps/chain";
import { JupiterClient, PreStocksClient, PythClient } from "@ps/market";
import { Store } from "@ps/db";

export interface Services {
  readonly rpc: Rpc;
  readonly jupiter: JupiterClient;
  readonly issuer: PreStocksClient;
  readonly pyth: PythClient;
  readonly store: Store;
}

export function createServices(): Services {
  return {
    rpc: new Rpc({
      url: process.env["SOLANA_RPC_URL"] ?? "https://solana-rpc.publicnode.com",
    }),
    jupiter: new JupiterClient(),
    issuer: new PreStocksClient(),
    pyth: new PythClient(),
    store: new Store(),
  };
}
