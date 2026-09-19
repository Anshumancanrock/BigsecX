/**
 * Pack swap instructions into as few versioned transactions as will hold them.
 *
 * A Solana transaction is capped at 1232 bytes on the wire. Jupiter routes are
 * account-heavy, so how many swaps fit is not something to guess: this packs
 * greedily and asks the compiler, adding one swap at a time and keeping the
 * last arrangement that actually serialized within budget.
 *
 * Fewer transactions is not merely tidier. Each one the user signs is another
 * dialog, another chance to abandon the flow, and another blockhash that can
 * expire -- and because they are separate transactions, a basket is not atomic.
 * Partial fills are a real outcome the caller has to handle.
 */

import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

/** Hard wire limit for a Solana transaction packet. */
export const PACKET_DATA_SIZE = 1232;

/**
 * Bytes reserved for signatures that are not yet attached.
 *
 * The transaction is compiled unsigned, so the serialized form carries empty
 * signature slots. Budgeting 64 bytes per required signature plus the
 * shortvec length prefix keeps a transaction that fits here from overflowing
 * once the wallet signs it.
 */
function signatureOverhead(transaction: VersionedTransaction): number {
  return 1 + 64 * transaction.message.header.numRequiredSignatures;
}

export interface PackedTransaction {
  readonly transaction: VersionedTransaction;
  /** Indices into the input group list that ended up in this transaction. */
  readonly groupIndices: readonly number[];
  readonly byteLength: number;
  /**
   * The instructions and tables this transaction was built from.
   *
   * Returned so a caller can recompile it -- notably to set a compute budget
   * that reflects how many swaps actually landed together, which is only known
   * after packing.
   */
  readonly instructions: readonly TransactionInstruction[];
  readonly lookupTables: readonly AddressLookupTableAccount[];
}

/**
 * One unit of work that must not be split across transactions.
 *
 * A swap and the setup it depends on -- creating the destination account, for
 * instance -- have to travel together, so the packer moves groups, not
 * individual instructions.
 */
export interface InstructionGroup {
  readonly instructions: readonly TransactionInstruction[];
  readonly lookupTables: readonly AddressLookupTableAccount[];
}

/**
 * Compile a message and report its exact wire size.
 *
 * Exposed so a caller can test whether a single group will fit before
 * committing to it, which is what drives the retry ladder for oversized routes.
 */
export function compileAndMeasure(args: {
  readonly payer: PublicKey;
  readonly blockhash: string;
  readonly instructions: readonly TransactionInstruction[];
  readonly lookupTables: readonly AddressLookupTableAccount[];
}): { readonly transaction: VersionedTransaction; readonly bytes: number } | null {
  try {
    const transaction = compile(args.payer, args.blockhash, args.instructions, args.lookupTables);
    return { transaction, bytes: measure(transaction) };
  } catch {
    return null;
  }
}

function compile(
  payer: PublicKey,
  blockhash: string,
  instructions: readonly TransactionInstruction[],
  lookupTables: readonly AddressLookupTableAccount[],
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...instructions],
  }).compileToV0Message([...lookupTables]);
  return new VersionedTransaction(message);
}

/** Bytes a compact-u16 length prefix occupies. */
function shortVecSize(length: number): number {
  if (length < 0x80) return 1;
  if (length < 0x4000) return 2;
  return 3;
}

/**
 * Exact wire size of a compiled v0 message.
 *
 * Neither `VersionedTransaction.serialize()` nor `MessageV0.serialize()` can be
 * used for this: both encode into a fixed 1232-byte buffer and throw once the
 * content passes it. A packer has to know how far over the limit a candidate
 * is in order to decide what to do about it, so the layout is measured
 * directly instead.
 */
function messageSize(message: VersionedTransaction["message"]): number {
  let size = 1; // version prefix byte
  size += 3; // header
  size += shortVecSize(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length;
  size += 32; // recent blockhash

  size += shortVecSize(message.compiledInstructions.length);
  for (const instruction of message.compiledInstructions) {
    size += 1; // program id index
    size += shortVecSize(instruction.accountKeyIndexes.length) + instruction.accountKeyIndexes.length;
    size += shortVecSize(instruction.data.length) + instruction.data.length;
  }

  size += shortVecSize(message.addressTableLookups.length);
  for (const lookup of message.addressTableLookups) {
    size += 32; // table address
    size += shortVecSize(lookup.writableIndexes.length) + lookup.writableIndexes.length;
    size += shortVecSize(lookup.readonlyIndexes.length) + lookup.readonlyIndexes.length;
  }
  return size;
}

/** Serialized size including the signature slots the wallet will fill. */
function measure(transaction: VersionedTransaction): number {
  return messageSize(transaction.message) + signatureOverhead(transaction);
}

/**
 * Greedily pack groups into transactions.
 *
 * `preamble` instructions (compute budget, typically) are repeated in every
 * transaction, because each one is independently executed and independently
 * priced.
 *
 * A group that cannot fit even on its own is reported in `oversized` rather
 * than thrown: one unroutable leg should not destroy a basket. It is never
 * dropped silently, because a caller who believed the basket was complete
 * would be wrong about what they own.
 */
export interface PackResult {
  readonly packed: readonly PackedTransaction[];
  /** Groups too large to execute, with the size they needed. */
  readonly oversized: readonly { readonly index: number; readonly bytes: number; readonly reason: string }[];
}

export function packGroups(args: {
  readonly payer: PublicKey;
  readonly blockhash: string;
  readonly groups: readonly InstructionGroup[];
  readonly preamble?: readonly TransactionInstruction[];
  readonly maxBytes?: number;
}): PackResult {
  const { payer, blockhash, groups, preamble = [], maxBytes = PACKET_DATA_SIZE } = args;
  const packed: PackedTransaction[] = [];
  const oversized: { index: number; bytes: number; reason: string }[] = [];

  let currentIndices: number[] = [];
  let currentInstructions: TransactionInstruction[] = [];
  let currentTables = new Map<string, AddressLookupTableAccount>();
  let currentBuilt: VersionedTransaction | null = null;
  let currentBytes = 0;

  const flush = () => {
    if (currentBuilt === null || currentIndices.length === 0) return;
    packed.push({
      transaction: currentBuilt,
      groupIndices: currentIndices,
      byteLength: currentBytes,
      instructions: currentInstructions,
      lookupTables: [...currentTables.values()],
    });
    currentIndices = [];
    currentInstructions = [];
    currentTables = new Map();
    currentBuilt = null;
    currentBytes = 0;
  };

  for (const [index, group] of groups.entries()) {
    const candidateInstructions = [...currentInstructions, ...group.instructions];
    const candidateTables = new Map(currentTables);
    for (const table of group.lookupTables) candidateTables.set(table.key.toBase58(), table);

    let built: VersionedTransaction | null = null;
    let bytes = Number.POSITIVE_INFINITY;
    try {
      built = compile(payer, blockhash, [...preamble, ...candidateInstructions], [
        ...candidateTables.values(),
      ]);
      bytes = measure(built);
    } catch {
      // Compilation fails when the message exceeds the account-index limits,
      // which is just another way of saying it does not fit.
      built = null;
    }

    if (built !== null && bytes <= maxBytes) {
      currentIndices = [...currentIndices, index];
      currentInstructions = candidateInstructions;
      currentTables = candidateTables;
      currentBuilt = built;
      currentBytes = bytes;
      continue;
    }

    // Does not fit alongside what is already staged. Close this transaction
    // and retry the group on its own.
    flush();

    const soloTables = new Map<string, AddressLookupTableAccount>();
    for (const table of group.lookupTables) soloTables.set(table.key.toBase58(), table);

    let solo: VersionedTransaction;
    try {
      solo = compile(payer, blockhash, [...preamble, ...group.instructions], [
        ...soloTables.values(),
      ]);
    } catch (error) {
      oversized.push({ index, bytes: Number.POSITIVE_INFINITY, reason: (error as Error).message });
      continue;
    }
    const soloBytes = measure(solo);
    if (soloBytes > maxBytes) {
      oversized.push({
        index,
        bytes: soloBytes,
        reason: `needs ${soloBytes} bytes, over the ${maxBytes}-byte limit even alone`,
      });
      continue;
    }

    currentIndices = [index];
    currentInstructions = [...group.instructions];
    currentTables = soloTables;
    currentBuilt = solo;
    currentBytes = soloBytes;
  }

  flush();
  return { packed, oversized };
}
