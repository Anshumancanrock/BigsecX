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
/** Wrapped SOL. Most PreStocks routes hop through it rather than stablecoin. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

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
  /**
   * Matching wrapped-SOL change, negative when the wallet spent.
   *
   * Carried because most routes here hop through SOL rather than stablecoin:
   * of eight trades sampled from mainnet, only two had a USDC leg. Ignoring
   * the SOL side discards three quarters of the observable cost basis.
   */
  readonly wsolDeltaRaw: bigint | null;
}

/** Owners that are program-controlled rather than people. */
function isCounterparty(owner: string, signers: ReadonlySet<string>): boolean {
  return !signers.has(owner);
}

/**
 * One page of signatures touching an address, newest first.
 *
 * `until` bounds the scan: the node returns signatures newer than it.
 * `before` pages backward from a signature already seen.
 */
export async function getSignatures(
  rpc: Rpc,
  address: string,
  options: { readonly limit?: number; readonly until?: string; readonly before?: string } = {},
): Promise<SignatureRef[]> {
  const params: Record<string, unknown> = { limit: options.limit ?? 50 };
  if (options.until) params["until"] = options.until;
  if (options.before) params["before"] = options.before;
  return rpc.call<SignatureRef[]>("getSignaturesForAddress", [address, params]);
}

/**
 * Every signature newer than `until`, across as many pages as allowed.
 *
 * A single page silently drops history whenever more than `limit` new
 * signatures have accumulated: the node returns the newest page, and
 * advancing the cursor to the top of it skips everything between that page
 * and the previous cursor. Paging backward with `before` closes that gap.
 *
 * `maxPages` bounds the work per run. When the budget runs out the result is
 * flagged `complete: false`, and the caller must not advance its cursor past
 * what it actually indexed or the same gap reopens.
 */
export async function getSignaturesSince(
  rpc: Rpc,
  address: string,
  options: {
    readonly until?: string | undefined;
    readonly pageSize?: number;
    readonly maxPages?: number;
  } = {},
): Promise<{ readonly signatures: SignatureRef[]; readonly complete: boolean }> {
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 3;

  const signatures: SignatureRef[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const batch = await getSignatures(rpc, address, {
      limit: pageSize,
      ...(options.until ? { until: options.until } : {}),
      ...(before ? { before } : {}),
    });
    signatures.push(...batch);

    // A short page means the node had nothing older left above `until`.
    if (batch.length < pageSize) return { signatures, complete: true };
    before = batch[batch.length - 1]?.signature;
    if (!before) return { signatures, complete: true };
  }
  return { signatures, complete: false };
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

  // How many watched mints each owner moved in this transaction. A stablecoin
  // leg can only be attributed to a token leg when there is exactly one; a
  // basket swap moves several against a single USDC delta, and pinning that
  // delta to each leg would count the same money once per leg.
  const legsPerOwner = new Map<string, number>();
  for (const [key, delta] of byOwnerMint) {
    const [owner, mint] = key.split("\u0000") as [string, string];
    if (!watchedMints.has(mint) || delta === 0n) continue;
    legsPerOwner.set(owner, (legsPerOwner.get(owner) ?? 0) + 1);
  }

  const trades: Trade[] = [];
  for (const [key, delta] of byOwnerMint) {
    const [owner, mint] = key.split("\u0000") as [string, string];
    if (!watchedMints.has(mint) || delta === 0n) continue;
    if (isCounterparty(owner, signers)) continue;

    const single = legsPerOwner.get(owner) === 1;
    const usdc = byOwnerMint.get(`${owner}\u0000${USDC_MINT}`) ?? null;
    const wsol = byOwnerMint.get(`${owner}\u0000${WSOL_MINT}`) ?? null;
    trades.push({
      signature,
      slot: response.slot,
      blockTime: response.blockTime,
      owner,
      mint,
      deltaRaw: delta,
      usdcDeltaRaw: single ? usdc : null,
      wsolDeltaRaw: single ? wsol : null,
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
): Promise<{ readonly trades: Trade[]; readonly missed: number }> {
  const batchSize = options.batchSize ?? 10;
  const trades: Trade[] = [];
  let missed = 0;

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
      // Report the loss upward. The caller must not advance its cursor past a
      // window it failed to read, or these signatures are never looked at
      // again and the gap is permanent.
      missed += slice.length;
      continue;
    }

    slice.forEach((signature, j) => {
      const response = responses[j];
      // A null response means the node has no record of it; nothing to index,
      // and nothing lost.
      if (response) trades.push(...extractTrades(signature, response, watchedMints));
    });
  }
  return { trades, missed };
}
