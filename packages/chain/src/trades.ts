/**
 * Reconstruct PreStocks trades from mainnet transaction history, which free
 * endpoints serve (unlike `getTokenLargestAccounts`). Each transaction shows
 * both the token and the cash leg, so it yields a cost basis. Amounts are raw;
 * the ScaledUiAmount multiplier is applied upstream, where mint state is known.
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
    fee: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: { pubkey: string; signer: boolean }[] };
  };
}

export interface Trade {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly owner: string;
  readonly mint: string;
  readonly deltaRaw: bigint;
  readonly usdcDeltaRaw: bigint | null;
  /**
   * Matching wrapped-SOL change, negative when the wallet spent. Most routes
   * hop through SOL rather than stablecoin, so this leg carries most of the
   * observable cost basis.
   */
  readonly wsolDeltaRaw: bigint | null;
  /**
   * Fee payer's native lamport change, with the transaction fee added back.
   *
   * Jupiter wraps and unwraps SOL inside the transaction, so a SOL-routed swap
   * leaves the wrapped account at zero and shows only here. Set only when the
   * fee payer also owns the token leg.
   */
  readonly lamportDeltaRaw: bigint | null;
}

function isCounterparty(owner: string, signers: ReadonlySet<string>): boolean {
  return !signers.has(owner);
}

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
 * Every signature newer than `until`, paging backward with `before`, since one
 * page returns only the newest `limit` and would skip the rest down to `until`.
 *
 * When `maxPages` runs out the result has `complete: false`, and the caller
 * must not advance its cursor past what it actually indexed.
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
    let batch: SignatureRef[];
    try {
      batch = await getSignatures(rpc, address, {
        limit: pageSize,
        ...(options.until ? { until: options.until } : {}),
        ...(before ? { before } : {}),
      });
    } catch (error) {
      // Free endpoints keep a short history, so an old cursor can name a
      // transaction the node no longer holds, and it then answers "not found"
      // for the whole request. Restart from the newest page; the scan is
      // incomplete because the stretch back to the old cursor is a gap.
      if (page === 0 && options.until && /not found/i.test((error as Error).message)) {
        const fresh = await getSignaturesSince(rpc, address, { ...options, until: undefined });
        return { signatures: fresh.signatures, complete: false };
      }
      throw error;
    }
    signatures.push(...batch);

    if (batch.length < pageSize) return { signatures, complete: true };
    before = batch[batch.length - 1]?.signature;
    if (!before) return { signatures, complete: true };
  }
  return { signatures, complete: false };
}

function extractTrades(
  signature: string,
  response: TransactionResponse,
  watchedMints: ReadonlySet<string>,
): Trade[] {
  const meta = response.meta;
  if (!meta || meta.err) return [];

  // A missing level in a response from an untrusted node would throw mid-parse
  // and fail the whole batch; unreadable account keys yield no trades instead.
  const accountKeys = response.transaction?.message?.accountKeys;
  if (!Array.isArray(accountKeys)) return [];

  const feePayer = accountKeys[0]?.pubkey ?? null;
  const preLamports = meta.preBalances?.[0];
  const postLamports = meta.postBalances?.[0];
  const lamportDelta =
    preLamports !== undefined && postLamports !== undefined
      ? BigInt(postLamports) - BigInt(preLamports) + BigInt(meta.fee)
      : null;

  // Only signers count as trading. Every swap also moves a pool's balance, and
  // pools would otherwise dominate any ranking built on the result.
  const signers = new Set(
    accountKeys.filter((k) => k.signer).map((k) => k.pubkey),
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

  const byOwnerMint = new Map<string, bigint>();
  for (const entry of deltas.values()) {
    const key = `${entry.owner}\u0000${entry.mint}`;
    byOwnerMint.set(key, (byOwnerMint.get(key) ?? 0n) + entry.delta);
  }

  // Watched mints moved per owner. Cash is attributed only when there is
  // exactly one: a basket swap moves several against one USDC delta, which
  // would otherwise be counted once per leg.
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
      lamportDeltaRaw: single && owner === feePayer ? lamportDelta : null,
    });
  }
  return trades;
}

export async function fetchTrades(
  rpc: Rpc,
  signatures: readonly string[],
  watchedMints: ReadonlySet<string>,
  options: {
    readonly batchSize?: number;
    readonly commitment?: "confirmed" | "finalized";
  } = {},
): Promise<{
  readonly trades: Trade[];
  readonly missed: number;
  readonly seen: readonly string[];
}> {
  const batchSize = options.batchSize ?? 10;
  const trades: Trade[] = [];
  const seen: string[] = [];
  let missed = 0;
  const paramsFor = (signature: string) => [
    signature,
    {
      maxSupportedTransactionVersion: 1,
      encoding: "jsonParsed",
      ...(options.commitment ? { commitment: options.commitment } : {}),
    },
  ];

  // The default endpoint allows one getTransaction per batch and mainnet-beta
  // rate limits large batches, so the first failed batch switches the rest of
  // the run to single calls.
  let batching = true;

  for (let i = 0; i < signatures.length; i += batchSize) {
    const slice = signatures.slice(i, i + batchSize);
    let responses: (TransactionResponse | null | undefined)[] | null = null;

    if (batching) {
      try {
        responses = await rpc.batch<TransactionResponse | null>(
          slice.map((signature) => ({ method: "getTransaction", params: paramsFor(signature) })),
        );
      } catch {
        batching = false;
      }
    }

    if (responses === null) {
      responses = [];
      for (const signature of slice) {
        try {
          responses.push(await rpc.call<TransactionResponse | null>("getTransaction", paramsFor(signature)));
        } catch {
          // Counted as missed so the caller keeps its cursor, since signatures
          // the cursor moves past are never revisited.
          responses.push(undefined);
          missed++;
        }
      }
    }

    slice.forEach((signature, j) => {
      const response = responses![j];
      if (response) {
        seen.push(signature);
        trades.push(...extractTrades(signature, response, watchedMints));
      }
    });
  }
  return { trades, missed, seen };
}
