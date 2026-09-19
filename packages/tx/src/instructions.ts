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
 * Several legs in one basket produce the same setup instruction -- creating
 * the wrapped-SOL account, for instance -- and sending it twice wastes space
 * and, for non-idempotent instructions, fails outright.
 */
export function instructionKey(source: JupiterInstruction): string {
  return [
    source.programId,
    source.accounts.map((a) => a.pubkey).join(","),
    source.data,
  ].join("|");
}
