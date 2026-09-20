/**
 * Discover the pool accounts carrying PreStocks flow.
 *
 * The trade indexer originally read signatures on the mints themselves, which
 * is a poor source: a mint's signature list contains every transaction that
 * merely references it -- transfers, account creations, fee harvests -- and
 * swaps are a small minority. Pool accounts are the opposite: essentially
 * everything touching them is a trade.
 *
 * The pools are not hardcoded because they change. Jupiter names the venue it
 * routed through in every quote, so asking for a quote at a representative
 * size and reading `routePlan[].swapInfo.ammKey` yields the addresses that are
 * actually carrying flow right now.
 */

import { USDC_DECIMALS, USDC_MINT, type PreStock } from "@ps/core";
import type { JupiterClient } from "./jupiter.ts";

export interface Venue {
  readonly ammKey: string;
  readonly label: string;
  readonly symbol: string;
}

/**
 * Probe each token at a few sizes and collect the venues Jupiter routes to.
 *
 * Several sizes, because routing is size-dependent: a small order may fill on
 * one book while a larger one splits across several, and a leaderboard wants
 * the venues carrying the large flow as much as the small.
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
          // Cache generously: the venue set moves far more slowly than price.
          10 * 60_000,
        );
        for (const step of quote.routePlan) {
          // Intermediate hops route through SOL and other tokens; only keep
          // the ones that actually touch this PreStock.
          const { ammKey, label, inputMint, outputMint } = step.swapInfo;
          if (inputMint !== token.mint && outputMint !== token.mint) continue;
          if (!byKey.has(ammKey)) byKey.set(ammKey, { ammKey, label, symbol: token.symbol });
        }
      } catch {
        // A token we cannot quote contributes no venues. The others still do.
        continue;
      }
    }
  }
  return [...byKey.values()];
}
