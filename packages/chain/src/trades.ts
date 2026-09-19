/**
 * Reconstruct PreStocks trades from mainnet transaction history.
 *
 * The obvious source of traders -- `getTokenLargestAccounts` -- is refused
 * outright by every free endpoint tested, returning 429 even for a single
 * call, and `getProgramAccounts` over 68,000 holder accounts is worse. Reading
 * signatures and transactions, which free endpoints do serve, works instead.
 *
 * It is also the better source. Largest-holder snapshots find whales who may
 * never trade; transaction history finds people who actually trade, and
 * because each transaction shows both the token and the stablecoin leg, it
 * yields a cost basis rather than a guess at one.
 *
 * Balances here are raw. The ScaledUiAmount multiplier is applied upstream,
 * where the mint state is known.
 */

import type { Rpc } from "./rpc.ts";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface SignatureRef {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err: unknown;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface TransactionResponse {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: { pubkey: string; signer: boolean }[] };
  };
}

/** A wallet's net position change in one transaction. */
export interface Trade {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly owner: string;
  readonly mint: string;
  /** Positive when the wallet gained tokens. */
  readonly deltaRaw: bigint;
  /** Matching USDC change, negative when the wallet spent. Null if absent. */
  readonly usdcDeltaRaw: bigint | null;
}

/** Owners that are program-controlled rather than people. */
function isCounterparty(owner: string, signers: ReadonlySet<string>): boolean {
  return !signers.has(owner);
}

/**
 * Recent signatures touching a mint.
 *
 * `until` makes this incremental: pass the newest signature already indexed
 * and only newer ones come back.
 */
export async function getSignatures(
  rpc: Rpc,
  address: string,
  options: { readonly limit?: number; readonly until?: string } = {},
): Promise<SignatureRef[]> {
  const params: Record<string, unknown> = { limit: options.limit ?? 50 };
  if (options.until) params["until"] = options.until;
  return rpc.call<SignatureRef[]>("getSignaturesForAddress", [address, params]);
}

/** Net token-balance change per owner in one transaction. */
function extractTrades(
  signature: string,
  response: TransactionResponse,
  watchedMints: ReadonlySet<string>,
): Trade[] {
  const meta = response.meta;
  if (!meta || meta.err) return [];

  // Only balance changes belonging to a signer count as that wallet trading.
  // Every swap also moves the pool's balance, and without this filter the
  // liquidity pools dominate any ranking built on the result.
  const signers = new Set(
    response.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey),
  );

  // Index by account rather than owner: an owner can hold several accounts in
  // the same mint, and each moves independently.
  const deltas = new Map<string, { owner: string; mint: string; delta: bigint }>();
  const apply = (balances: readonly TokenBalance[] | undefined, sign: bigint) => {
    for (const balance of balances ?? []) {
      if (!balance.owner) continue;
      const key = `${balance.accountIndex}`;
      const existing = deltas.get(key);
      const amount = BigInt(balance.uiTokenAmount.amount) * sign;
      deltas.set(key, {
        owner: balance.owner,
        mint: balance.mint,
        delta: (existing?.delta ?? 0n) + amount,
      });
    }
  };
  apply(meta.preTokenBalances, -1n);
  apply(meta.postTokenBalances, 1n);

  // Roll account-level deltas up to owner and mint.
  const byOwnerMint = new Map<string, bigint>();
  for (const entry of deltas.values()) {
    const key = `${entry.owner}\u0000${entry.mint}`;
    byOwnerMint.set(key, (byOwnerMint.get(key) ?? 0n) + entry.delta);
  }

  const trades: Trade[] = [];
  for (const [key, delta] of byOwnerMint) {
    const [owner, mint] = key.split("\u0000") as [string, string];
    if (!watchedMints.has(mint) || delta === 0n) continue;
    if (isCounterparty(owner, signers)) continue;
    trades.push({
      signature,
      slot: response.slot,
      blockTime: response.blockTime,
      owner,
      mint,
      deltaRaw: delta,
      usdcDeltaRaw: byOwnerMint.get(`${owner}\u0000${USDC_MINT}`) ?? null,
    });
  }
  return trades;
}

/**
 * Fetch and parse transactions.
 *
 * Requests go out in small batches and sequentially. Public endpoints tolerate
 * this method but not a burst of it, and the indexer is a background job where
 * finishing reliably matters more than finishing quickly.
 */
export async function fetchTrades(
  rpc: Rpc,
  signatures: readonly string[],
  watchedMints: ReadonlySet<string>,
  options: { readonly batchSize?: number } = {},
): Promise<Trade[]> {
  const batchSize = options.batchSize ?? 10;
  const trades: Trade[] = [];

  for (let i = 0; i < signatures.length; i += batchSize) {
    const slice = signatures.slice(i, i + batchSize);
    let responses: (TransactionResponse | null)[];
    try {
      responses = await rpc.batch<TransactionResponse | null>(
        slice.map((signature) => ({
          method: "getTransaction",
          // Version 1 transactions are live on mainnet; requesting only
          // version 0 makes the node refuse them outright.
          params: [signature, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" }],
        })),
      );
    } catch {
      // Losing a batch costs coverage, not correctness: these signatures stay
      // unindexed and will be picked up on a later pass.
      continue;
    }

    slice.forEach((signature, j) => {
      const response = responses[j];
      if (response) trades.push(...extractTrades(signature, response, watchedMints));
    });
  }
  return trades;
}
