/**
 * Read Token-2022 mint state and turn the extension soup into the narrow
 * shapes the rest of the app understands.
 *
 * Everything the money math needs -- the active scale multiplier and the active
 * transfer fee -- lives on the mint and changes without notice. Nothing here is
 * cached for long: a split or a fee bump takes effect at a timestamp or an
 * epoch boundary, and stale values produce confidently wrong prices.
 */

import type { ScaledUiAmountConfig, TransferFeeConfig } from "@ps/core";
import { UNCAPPED_FEE } from "@ps/core";
import type { Rpc } from "./rpc.ts";

interface ParsedExtension {
  extension: string;
  state?: Record<string, unknown>;
}

interface ParsedMintInfo {
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions?: ParsedExtension[];
}

interface ParsedAccount {
  data: { parsed: { info: ParsedMintInfo; type: string }; program: string };
  owner: string;
}

/** Everything about a mint that affects what a user sees or pays. */
export interface MintState {
  readonly mint: string;
  readonly decimals: number;
  readonly rawSupply: bigint;
  readonly scale: ScaledUiAmountConfig;
  readonly transferFee: TransferFeeConfig;
  /** True when transfers are halted by the pausable extension. */
  readonly paused: boolean;
  /** Set when the issuer can seize balances from any account. */
  readonly permanentDelegate: string | null;
  readonly freezeAuthority: string | null;
  /** Non-null means transfers invoke a hook program we do not control. */
  readonly transferHookProgramId: string | null;
}

function extensionState(
  extensions: readonly ParsedExtension[],
  name: string,
): Record<string, unknown> | undefined {
  return extensions.find((e) => e.extension === name)?.state;
}

function readScale(extensions: readonly ParsedExtension[]): ScaledUiAmountConfig {
  const state = extensionState(extensions, "scaledUiAmountConfig");
  if (!state) return { multiplier: 1, newMultiplier: 1, newMultiplierEffectiveTimestamp: 0 };
  // The RPC renders these as strings ("1", "1.4861347"); parse rather than cast.
  return {
    multiplier: Number(state["multiplier"]),
    newMultiplier: Number(state["newMultiplier"]),
    newMultiplierEffectiveTimestamp: Number(state["newMultiplierEffectiveTimestamp"]),
  };
}

function readTransferFee(extensions: readonly ParsedExtension[]): TransferFeeConfig {
  const state = extensionState(extensions, "transferFeeConfig");
  const none = { epoch: 0, transferFeeBasisPoints: 0, maximumFee: UNCAPPED_FEE };
  if (!state) return { olderTransferFee: none, newerTransferFee: none };

  const read = (raw: unknown) => {
    const fee = raw as {
      epoch: number;
      transferFeeBasisPoints: number;
      maximumFee: number | string;
    };
    return {
      epoch: Number(fee.epoch),
      transferFeeBasisPoints: Number(fee.transferFeeBasisPoints),
      // maximumFee is u64 and arrives as a JSON number that has already lost
      // precision at the u64::MAX sentinel. Go through the string form.
      maximumFee: BigInt(String(fee.maximumFee)),
    };
  };

  return {
    olderTransferFee: read(state["olderTransferFee"]),
    newerTransferFee: read(state["newerTransferFee"]),
  };
}

function parseMint(mint: string, account: ParsedAccount | null): MintState {
  if (!account) throw new Error(`mint ${mint} not found`);
  const info = account.data.parsed.info;
  const extensions = info.extensions ?? [];

  const pausable = extensionState(extensions, "pausableConfig");
  const delegate = extensionState(extensions, "permanentDelegate");
  const hook = extensionState(extensions, "transferHook");

  return {
    mint,
    decimals: info.decimals,
    rawSupply: BigInt(info.supply),
    scale: readScale(extensions),
    transferFee: readTransferFee(extensions),
    paused: pausable?.["paused"] === true,
    permanentDelegate: (delegate?.["delegate"] as string | undefined) ?? null,
    freezeAuthority: info.freezeAuthority,
    transferHookProgramId: (hook?.["programId"] as string | null | undefined) ?? null,
  };
}

/** Fetch one mint's state. */
export async function getMintState(rpc: Rpc, mint: string): Promise<MintState> {
  const result = await rpc.call<{ value: ParsedAccount | null }>("getAccountInfo", [
    mint,
    { encoding: "jsonParsed" },
  ]);
  return parseMint(mint, result.value);
}

/**
 * Fetch several mints in one round trip.
 *
 * getMultipleAccounts caps at 100 addresses, which is far above the size of
 * this universe, so no chunking is needed yet.
 */
export async function getMintStates(
  rpc: Rpc,
  mints: readonly string[],
): Promise<Map<string, MintState>> {
  if (mints.length === 0) return new Map();
  const result = await rpc.call<{ value: (ParsedAccount | null)[] }>("getMultipleAccounts", [
    mints,
    { encoding: "jsonParsed" },
  ]);
  const states = new Map<string, MintState>();
  mints.forEach((mint, i) => {
    states.set(mint, parseMint(mint, result.value[i] ?? null));
  });
  return states;
}

/** A wallet's raw balance in one mint. */
export interface TokenPosition {
  readonly mint: string;
  readonly tokenAccount: string;
  readonly rawAmount: bigint;
}

/**
 * Read a wallet's PreStocks positions.
 *
 * Deliberately returns raw amounts. The RPC also reports a `uiAmount`, and for
 * a scaled mint that field is already multiplier-adjusted -- but it is a float
 * the node computed, and mixing it with our own conversions would give two
 * sources of truth for the same number. Convert from raw at the edge instead.
 */
export async function getPositions(
  rpc: Rpc,
  owner: string,
  programId: string,
): Promise<TokenPosition[]> {
  const result = await rpc.call<{
    value: {
      pubkey: string;
      account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } };
    }[];
  }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed" }]);

  return result.value.map((entry) => ({
    mint: entry.account.data.parsed.info.mint,
    tokenAccount: entry.pubkey,
    rawAmount: BigInt(entry.account.data.parsed.info.tokenAmount.amount),
  }));
}
