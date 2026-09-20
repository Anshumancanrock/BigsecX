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
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  UNIVERSE,
  USDC_DECIMALS,
  USDC_MINT,
} from "@ps/core";
import { PublicKey } from "@solana/web3.js";

/**
 * Derive the associated token account for a Token-2022 mint.
 *
 * The token program id is part of the seeds, so passing the legacy program id
 * yields a different, wrong address.
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
   * True when the issuer has frozen this account.
   *
   * A frozen account still reports its full balance, so a coverage check that
   * only compares amounts passes it and the swap fails on chain after the
   * user has signed. The issuer holds freeze authority on every one of these
   * mints, so this is a real state, not a theoretical one.
   */
  readonly frozen: boolean;
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
    const frozen = account?.data.parsed.info.state === "frozen";

    balances.set(token.symbol, {
      symbol: token.symbol,
      rawAmount,
      frozen,
      uiAmount: scale
        ? rawToUi(rawAmount, token.decimals, scale, atUnixSeconds)
        : Number(rawAmount) / 10 ** token.decimals,
    });
  });
  return balances;
}

/** Legacy SPL token program, which is what USDC is minted under. */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * The stablecoin and lamport balances a buy leg spends.
 *
 * Sell legs were checked against the chain while buy legs were checked
 * against nothing, so a wallet with no USDC -- or with USDC but no SOL for
 * fees -- still received a signable bundle that could not land.
 *
 * USDC is a legacy SPL mint, so its associated account derives under a
 * different token program than the PreStocks ones.
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
