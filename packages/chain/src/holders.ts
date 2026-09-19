/**
 * Discover the largest holders of each mint.
 *
 * `getTokenLargestAccounts` returns the top 20 token *accounts* per mint, not
 * the top owners, and one owner can hold several accounts. Owners are resolved
 * and their accounts summed, so a market maker spread across fifty accounts
 * counts once.
 *
 * This is a deliberate ceiling. A full holder set would mean
 * `getProgramAccounts` over 68,000 ANTHROPIC accounts, which public endpoints
 * either refuse or throttle to uselessness. The top-20 window is what a
 * no-budget deployment can sustain, and any surface built on it should say so
 * rather than imply it ranks every holder.
 */

import type { Rpc } from "./rpc.ts";

export const LARGEST_ACCOUNTS_PER_MINT = 20;
/** Mints per batched request. Larger batches time out on public endpoints. */
const HOLDERS_BATCH_SIZE = 2;

export interface HolderBalance {
  readonly owner: string;
  readonly mint: string;
  readonly rawAmount: bigint;
}

interface LargestAccount {
  address: string;
  amount: string;
}

interface ParsedTokenAccount {
  data: { parsed: { info: { owner: string; mint: string; tokenAmount: { amount: string } } } };
}

/**
 * Largest holders across several mints.
 *
 * Calls are issued per mint and then owners are resolved in one batch, which
 * keeps the request count at `mints + 1` rather than `mints * 20`.
 */
export async function getLargestHolders(
  rpc: Rpc,
  mints: readonly string[],
): Promise<HolderBalance[]> {
  // Sequential small batches. Firing all eight in parallel draws a 429, and
  // putting all eight in one batch exceeds the request timeout -- these scans
  // are expensive server side. Two per request is what actually completes.
  const perMint: { mint: string; accounts: LargestAccount[] }[] = [];
  for (let i = 0; i < mints.length; i += HOLDERS_BATCH_SIZE) {
    const slice = mints.slice(i, i + HOLDERS_BATCH_SIZE);
    const results = await rpc.batch<{ value: LargestAccount[] }>(
      slice.map((mint) => ({
        method: "getTokenLargestAccounts",
        params: [mint, { commitment: "confirmed" }],
      })),
    );
    slice.forEach((mint, j) => {
      perMint.push({
        mint,
        accounts: (results[j]?.value ?? []).filter((a) => BigInt(a.amount) > 0n),
      });
    });
  }

  const addresses = perMint.flatMap((entry) => entry.accounts.map((a) => a.address));
  if (addresses.length === 0) return [];

  // getMultipleAccounts caps at 100 addresses per call.
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 100) chunks.push(addresses.slice(i, i + 100));

  const resolved = new Map<string, { owner: string; mint: string; rawAmount: bigint }>();
  for (const chunk of chunks) {
    const result = await rpc.call<{ value: (ParsedTokenAccount | null)[] }>(
      "getMultipleAccounts",
      [chunk, { encoding: "jsonParsed" }],
    );
    chunk.forEach((address, i) => {
      const account = result.value[i];
      if (!account) return;
      const info = account.data.parsed.info;
      resolved.set(address, {
        owner: info.owner,
        mint: info.mint,
        rawAmount: BigInt(info.tokenAmount.amount),
      });
    });
  }

  // Sum an owner's accounts within each mint.
  const totals = new Map<string, HolderBalance>();
  for (const entry of resolved.values()) {
    const key = `${entry.owner}:${entry.mint}`;
    const existing = totals.get(key);
    totals.set(key, {
      owner: entry.owner,
      mint: entry.mint,
      rawAmount: (existing?.rawAmount ?? 0n) + entry.rawAmount,
    });
  }
  return [...totals.values()];
}
