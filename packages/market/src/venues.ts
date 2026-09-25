/**
 * Discovers the pool accounts carrying PreStocks flow. Nearly every transaction
 * on a pool is a trade, while a mint's signature list is mostly transfers and
 * account churn. Pools change, so they are read from live Jupiter route plans
 * (`routePlan[].swapInfo.ammKey`) rather than hardcoded.
 */

import { USDC_DECIMALS, USDC_MINT, type PreStock } from "@ps/core";
import type { JupiterClient } from "./jupiter.ts";

export interface Venue {
  readonly ammKey: string;
  readonly label: string;
  readonly symbol: string;
}

/**
 * Quotes each token at several sizes and collects the venues Jupiter routes
 * through. Several sizes because a larger order may split across more pools.
 */
export async function discoverVenues(
  jupiter: JupiterClient,
  tokens: readonly PreStock[],
  options: { readonly probeSizesUsd?: readonly number[] } = {},
): Promise<Venue[]> {
  const sizes = options.probeSizesUsd ?? [500, 5_000];
  const byKey = new Map<string, Venue>();

  for (const token of tokens) {
    for (const usd of sizes) {
      try {
        const quote = await jupiter.quote(
          {
            inputMint: USDC_MINT,
            outputMint: token.mint,
            amount: BigInt(Math.round(usd * 10 ** USDC_DECIMALS)),
          },
          // The venue set changes far more slowly than price.
          10 * 60_000,
        );
        for (const step of quote.routePlan) {
          // Skip intermediate hops (via SOL and others) that do not touch this token.
          const { ammKey, label, inputMint, outputMint } = step.swapInfo;
          if (inputMint !== token.mint && outputMint !== token.mint) continue;
          if (!byKey.has(ammKey)) byKey.set(ammKey, { ammKey, label, symbol: token.symbol });
        }
      } catch {
        // An unquotable token contributes no venues; the others still do.
        continue;
      }
    }
  }
  return [...byKey.values()];
}
