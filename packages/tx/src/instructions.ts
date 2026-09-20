/**
 * Convert Jupiter's JSON instruction format into web3.js instructions, and
 * rebuild address lookup tables from the data Jupiter already sent.
 *
 * The lookup tables matter more than they look. A single-hop PreStocks swap
 * carries 29 accounts; at 32 bytes each that is 928 bytes of a 1232-byte
 * transaction before any instruction data. Lookup tables collapse each of
 * those to a one-byte index, which is the difference between fitting one swap
 * per transaction and fitting several.
 *
 * Jupiter returns `addressesByLookupTableAddress` inline, so the tables can be
 * reconstructed without an extra RPC round trip per table.
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

/** The subset of /swap-instructions we consume. */
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
 * Rebuild lookup tables from the inline address map.
 *
 * Only `key` and `state.addresses` are read when a message is compiled, so the
 * remaining state fields are filled with values that mark the table active:
 * a deactivation slot of u64::MAX means "never deactivated".
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
 * A stable identity for an instruction, used to drop duplicates.
 *
 * Only ever applied WITHIN a single transaction. Deduplicating across a whole
 * bundle is a trap: every sell leg emits the same "create the USDC destination
 * account" setup, so global dedup keeps it in the first leg's group and drops
 * it from the rest -- and those groups are packed into different
 * transactions. A wallet that does not already hold USDC would have the first
 * transaction create the account and every later one fail against an account
 * that does not exist yet.
 */
export function instructionKey(source: JupiterInstruction): string {
  return [
    source.programId,
    source.accounts.map((a) => a.pubkey).join(","),
    source.data,
  ].join("|");
}

/**
 * Drop repeated instructions from ONE transaction.
 *
 * Scope is the whole point. Legs that share a transaction often repeat the
 * same idempotent account creation and only need it once; legs in different
 * transactions each need their own copy, because a transaction cannot depend
 * on one that may not have landed.
 */
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
