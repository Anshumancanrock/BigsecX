/**
 * Wallet balances for trading. Jupiter spends only from the associated token
 * account, so the sellable balance is the ATA balance; a sell above it fails
 * with custom program error 0x1788. Tokens in other accounts are reported separately.
 */

import { rawToUi, type ScaledUiAmountConfig } from "@ps/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  UNIVERSE,
  USDC_DECIMALS,
  USDC_MINT,
} from "@ps/core";
import { PublicKey } from "@solana/web3.js";

/**
 * Associated token account address. The token program id is a seed, so it must
 * be the mint's own program (Token-2022 by default).
 */
export function associatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgramId: string = TOKEN_2022_PROGRAM_ID,
): string {
  const [address] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBytes(),
      new PublicKey(tokenProgramId).toBytes(),
      new PublicKey(mint).toBytes(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return address.toBase58();
}

interface ParsedTokenAccount {
  data: {
    parsed: { info: { mint: string; state?: string; tokenAmount: { amount: string } } };
  };
}

export interface SellableBalance {
  readonly symbol: string;
  readonly uiAmount: number;
  readonly rawAmount: bigint;
  /**
   * True when the issuer has frozen this account. A frozen account still reports
   * its full balance, so an amount check alone passes it. The issuer holds
   * freeze authority on every PreStocks mint.
   */
  readonly frozen: boolean;
  /**
   * False when the ATA does not exist yet. A buy opens it, which costs a SOL
   * rent deposit on top of the network fee.
   */
  readonly exists: boolean;
}

/**
 * Reads the owner's ATA balance for every token in one `getMultipleAccounts`
 * call. Missing accounts are reported as zero rather than omitted, so "holds
 * nothing" is distinct from "not checked".
 */
export async function getSellableBalances(
  rpc: { call: <T>(method: string, params?: unknown[]) => Promise<T> },
  owner: string,
  scaleBySymbol: ReadonlyMap<string, ScaledUiAmountConfig>,
  atUnixSeconds: number,
): Promise<Map<string, SellableBalance>> {
  const addresses = UNIVERSE.map((token) => associatedTokenAddress(owner, token.mint));

  const result = await rpc.call<{ value: (ParsedTokenAccount | null)[] }>(
    "getMultipleAccounts",
    [addresses, { encoding: "jsonParsed" }],
  );

  const balances = new Map<string, SellableBalance>();
  UNIVERSE.forEach((token, i) => {
    const account = result.value[i];
    const rawAmount = account ? BigInt(account.data.parsed.info.tokenAmount.amount) : 0n;
    const scale = scaleBySymbol.get(token.symbol);
    const frozen = account?.data.parsed.info.state === "frozen";

    balances.set(token.symbol, {
      symbol: token.symbol,
      rawAmount,
      frozen,
      exists: account !== null && account !== undefined,
      uiAmount: scale
        ? rawToUi(rawAmount, token.decimals, scale, atUnixSeconds)
        : Number(rawAmount) / 10 ** token.decimals,
    });
  });
  return balances;
}

/** Tokens a wallet owns but that sit outside its associated token account. */
export interface StrandedBalance {
  readonly symbol: string;
  readonly uiAmount: number;
  readonly accounts: number;
}

/**
 * PreStocks tokens the owner holds outside the ATA: owned, but not spendable by
 * a swap. Disclosure only, so it returns an empty map on failure or timeout
 * instead of throwing.
 */
export async function getStrandedBalances(
  rpc: { call: <T>(method: string, params?: unknown[]) => Promise<T> },
  owner: string,
  scaleBySymbol: ReadonlyMap<string, ScaledUiAmountConfig>,
  atUnixSeconds: number,
  timeoutMs = 8_000,
): Promise<Map<string, StrandedBalance>> {
  const stranded = new Map<string, StrandedBalance>();
  type Page = { value: { pubkey: string; account: ParsedTokenAccount }[] };
  // One query per mint: filtering by token program returns every Token-2022
  // account the wallet has, which can be tens of megabytes.
  const calls = UNIVERSE.map((token) => ({
    method: "getTokenAccountsByOwner",
    params: [owner, { mint: token.mint }, { encoding: "jsonParsed" }],
  }));
  let pages: Page[];
  try {
    // Capped at timeoutMs: the RPC client's own retries run far longer, and no
    // trade depends on this.
    pages = await Promise.race([
      // Separate calls, not a batch: publicnode allows one of these per batch
      // and mainnet-beta rate limits an eight-item batch.
      Promise.all(calls.map((c) => rpc.call<Page>(c.method, c.params))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stranded scan timed out")), timeoutMs)),
    ]);
  } catch {
    return stranded;
  }
  const result: Page = { value: pages.flatMap((page) => (Array.isArray(page?.value) ? page.value : [])) };
  if (!Array.isArray(result?.value)) return stranded;

  const bySymbolRaw = new Map<string, { raw: bigint; accounts: number }>();
  for (const entry of result.value) {
    const info = entry?.account?.data?.parsed?.info as { mint?: string; tokenAmount?: { amount?: string } } | undefined;
    const token = UNIVERSE.find((t) => t.mint === info?.mint);
    if (!token || !info?.tokenAmount?.amount) continue;
    // The ATA is already counted by the portfolio; only the rest is stranded.
    if (entry.pubkey === associatedTokenAddress(owner, token.mint)) continue;

    const raw = BigInt(info.tokenAmount.amount);
    if (raw <= 0n) continue;
    const prior = bySymbolRaw.get(token.symbol) ?? { raw: 0n, accounts: 0 };
    bySymbolRaw.set(token.symbol, { raw: prior.raw + raw, accounts: prior.accounts + 1 });
  }

  for (const [symbol, { raw, accounts }] of bySymbolRaw) {
    const token = UNIVERSE.find((t) => t.symbol === symbol)!;
    const scale = scaleBySymbol.get(symbol);
    stranded.set(symbol, {
      symbol,
      accounts,
      uiAmount: scale ? rawToUi(raw, token.decimals, scale, atUnixSeconds) : Number(raw) / 10 ** token.decimals,
    });
  }
  return stranded;
}

/** Legacy SPL token program, which is what USDC is minted under. */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * USDC and lamport balances, for checking that buy legs and fees are covered.
 * USDC is a legacy SPL mint, so its ATA derives under the legacy token program.
 */
export async function getSpendable(
  rpc: {
    call: <T>(method: string, params?: unknown[]) => Promise<T>;
  },
  owner: string,
): Promise<{ readonly usdc: number; readonly lamports: number }> {
  const usdcAta = associatedTokenAddress(owner, USDC_MINT, TOKEN_PROGRAM_ID);

  const [accounts, balance] = await Promise.all([
    rpc.call<{ value: (ParsedTokenAccount | null)[] }>("getMultipleAccounts", [
      [usdcAta],
      { encoding: "jsonParsed" },
    ]),
    rpc.call<{ value: number }>("getBalance", [owner]),
  ]);

  const account = accounts.value[0];
  const raw = account ? BigInt(account.data.parsed.info.tokenAmount.amount) : 0n;
  return { usdc: Number(raw) / 10 ** USDC_DECIMALS, lamports: balance.value };
}

export interface SellCheck {
  readonly symbol: string;
  readonly requestedUsd: number;
  readonly availableUsd: number;
  /** Set when the shortfall is a freeze rather than a balance. */
  readonly frozen?: boolean;
}

/**
 * Sell legs the wallet cannot cover. The tolerance only absorbs floating-point
 * noise: any leg above the balance fails on chain with 0x1788 after signing.
 */
export function findUncoveredSells(
  legs: readonly { readonly symbol: string; readonly side: "buy" | "sell"; readonly usd: number }[],
  balances: ReadonlyMap<string, SellableBalance>,
  priceUsdBySymbol: ReadonlyMap<string, number>,
  tolerance = 1e-9,
): SellCheck[] {
  const uncovered: SellCheck[] = [];

  for (const leg of legs) {
    if (leg.side !== "sell") continue;
    const price = priceUsdBySymbol.get(leg.symbol);
    if (price === undefined || price <= 0) continue;

    const balance = balances.get(leg.symbol);
    const availableUsd = (balance?.uiAmount ?? 0) * price;

    // A frozen account cannot move a single unit, whatever it reports.
    if (balance?.frozen) {
      uncovered.push({
        symbol: leg.symbol,
        requestedUsd: leg.usd,
        availableUsd: 0,
        frozen: true,
      });
      continue;
    }
    if (leg.usd > availableUsd * (1 + tolerance)) {
      uncovered.push({ symbol: leg.symbol, requestedUsd: leg.usd, availableUsd });
    }
  }
  return uncovered;
}
