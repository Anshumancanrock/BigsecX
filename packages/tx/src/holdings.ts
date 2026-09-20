/**
 * What a wallet can actually sell.
 *
 * Jupiter spends from the associated token account, not from whatever the
 * owner holds in total. Those differ: a market-maker wallet inspected on
 * mainnet held 133 ANTHROPIC spread over 49 accounts while its ATA held
 * 0.0001, and a sell built against the total failed with custom program error
 * 0x1788 -- insufficient balance in the source account.
 *
 * So sellable balance means the ATA balance, and nothing else.
 */

import { rawToUi, type ScaledUiAmountConfig } from "@ps/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, UNIVERSE } from "@ps/core";
import { PublicKey } from "@solana/web3.js";

/**
 * Derive the associated token account for a Token-2022 mint.
 *
 * The token program id is part of the seeds, so passing the legacy program id
 * yields a different, wrong address.
 */
export function associatedTokenAddress(owner: string, mint: string): string {
  const [address] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBytes(),
      new PublicKey(TOKEN_2022_PROGRAM_ID).toBytes(),
      new PublicKey(mint).toBytes(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return address.toBase58();
}

interface ParsedTokenAccount {
  data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } };
}

export interface SellableBalance {
  readonly symbol: string;
  readonly uiAmount: number;
  readonly rawAmount: bigint;
}

/**
 * Read the owner's sellable balance for every token in the universe.
 *
 * One `getMultipleAccounts` call covers all of them. Accounts that do not
 * exist come back null and are reported as a zero balance rather than being
 * omitted, so a caller can tell "holds nothing" from "was not checked".
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

    balances.set(token.symbol, {
      symbol: token.symbol,
      rawAmount,
      uiAmount: scale
        ? rawToUi(rawAmount, token.decimals, scale, atUnixSeconds)
        : Number(rawAmount) / 10 ** token.decimals,
    });
  });
  return balances;
}

export interface SellCheck {
  readonly symbol: string;
  readonly requestedUsd: number;
  readonly availableUsd: number;
}

/**
 * Find sell legs the wallet cannot cover.
 *
 * A small tolerance absorbs the gap between the price a plan was built at and
 * the balance read a moment later; without it, selling an entire position
 * fails on a rounding difference.
 */
export function findUncoveredSells(
  legs: readonly { readonly symbol: string; readonly side: "buy" | "sell"; readonly usd: number }[],
  balances: ReadonlyMap<string, SellableBalance>,
  priceUsdBySymbol: ReadonlyMap<string, number>,
  tolerance = 0.01,
): SellCheck[] {
  const uncovered: SellCheck[] = [];

  for (const leg of legs) {
    if (leg.side !== "sell") continue;
    const price = priceUsdBySymbol.get(leg.symbol);
    if (price === undefined || price <= 0) continue;

    const availableUsd = (balances.get(leg.symbol)?.uiAmount ?? 0) * price;
    if (leg.usd > availableUsd * (1 + tolerance)) {
      uncovered.push({ symbol: leg.symbol, requestedUsd: leg.usd, availableUsd });
    }
  }
  return uncovered;
}
