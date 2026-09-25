/**
 * Read Token-2022 mint state into the narrow shapes the app uses. The scale
 * multiplier and transfer fee live on the mint and change at a timestamp or
 * epoch boundary without notice, so this state must not be cached for long.
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
  /** Set when transfers invoke a hook program outside this app's control. */
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
      // maximumFee is u64: it arrives as a string or as a JSON number already
      // imprecise at the u64::MAX sentinel, and String() accepts both.
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

/**
 * Fetch several mints in one round trip. getMultipleAccounts takes at most 100
 * addresses, far more than the universe holds, so requests are not chunked.
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
