/**
 * Converts Jupiter's JSON instructions to web3.js and rebuilds lookup tables
 * from the inline `addressesByLookupTableAddress`, with no RPC call per table.
 * A single-hop PreStocks swap has 29 accounts (928 of the 1232 bytes as plain
 * keys); a lookup table reduces each to a one-byte index.
 */

import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

/** Jupiter's wire format for an instruction. */
export interface JupiterInstruction {
  readonly programId: string;
  readonly accounts: readonly {
    readonly pubkey: string;
    readonly isSigner: boolean;
    readonly isWritable: boolean;
  }[];
  /** base64 */
  readonly data: string;
}

/** The fields of the /swap-instructions response used here. */
export interface SwapInstructionsResponse {
  readonly tokenLedgerInstruction: JupiterInstruction | null;
  readonly computeBudgetInstructions: readonly JupiterInstruction[];
  readonly setupInstructions: readonly JupiterInstruction[];
  readonly swapInstruction: JupiterInstruction;
  readonly cleanupInstruction: JupiterInstruction | null;
  readonly otherInstructions: readonly JupiterInstruction[];
  readonly addressLookupTableAddresses: readonly string[];
  /** Present on current versions; saves fetching each table from chain. */
  readonly addressesByLookupTableAddress?: Readonly<Record<string, readonly string[]>>;
  readonly computeUnitLimit?: number;
  readonly simulationError?: unknown;
}

export function toInstruction(source: JupiterInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(source.programId),
    keys: source.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(source.data, "base64"),
  });
}

/**
 * Rebuilds lookup tables from the inline address map. Compilation reads only
 * `key` and `state.addresses`; the other fields just mark the table active
 * (a deactivation slot of u64::MAX means never deactivated).
 */
export function lookupTablesFrom(
  response: SwapInstructionsResponse,
): AddressLookupTableAccount[] {
  const byAddress = response.addressesByLookupTableAddress;
  if (!byAddress) return [];

  return Object.entries(byAddress).map(
    ([address, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(address),
        state: {
          deactivationSlot: 2n ** 64n - 1n,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: addresses.map((entry) => new PublicKey(entry)),
        },
      }),
  );
}

/**
 * Identity of an instruction, for dropping duplicates within one transaction.
 * Never dedupe across a bundle: each transaction needs its own setup (such as
 * creating the USDC account), since an earlier transaction may not land.
 */
export function instructionKey(source: JupiterInstruction): string {
  return [
    source.programId,
    source.accounts.map((a) => a.pubkey).join(","),
    source.data,
  ].join("|");
}

/** Drops repeated instructions (typically account creations) within one transaction. */
export function dedupeWithinTransaction(
  instructions: readonly TransactionInstruction[],
): TransactionInstruction[] {
  const seen = new Set<string>();
  return instructions.filter((instruction) => {
    const key = compiledInstructionKey(instruction);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The same identity, for an already-converted instruction. */
export function compiledInstructionKey(source: TransactionInstruction): string {
  return [
    source.programId.toBase58(),
    source.keys.map((k) => k.pubkey.toBase58()).join(","),
    Buffer.from(source.data).toString("base64"),
  ].join("|");
}
