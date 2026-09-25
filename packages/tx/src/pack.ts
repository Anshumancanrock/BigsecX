/**
 * Packs swap instructions into as few 1232-byte versioned transactions as
 * possible, compiling each candidate to measure it. The transactions are not
 * atomic with each other, so a basket can fill partially.
 */

import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

export const PACKET_DATA_SIZE = 1232;

function signatureOverhead(transaction: VersionedTransaction): number {
  return 1 + 64 * transaction.message.header.numRequiredSignatures;
}

export interface PackedTransaction {
  readonly transaction: VersionedTransaction;
  readonly groupIndices: readonly number[];
  readonly byteLength: number;
  /**
   * Instructions without the preamble, so the caller can recompile with a
   * compute budget sized to the swaps packed together.
   */
  readonly instructions: readonly TransactionInstruction[];
  readonly lookupTables: readonly AddressLookupTableAccount[];
}

/**
 * Instructions that must share a transaction, such as a swap and the setup that
 * creates its destination account.
 */
export interface InstructionGroup {
  readonly instructions: readonly TransactionInstruction[];
  readonly lookupTables: readonly AddressLookupTableAccount[];
}

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
 * Exact wire size of a compiled v0 message, computed from its layout because
 * web3.js `serialize()` writes into a fixed 1232-byte buffer and throws past it.
 */
function messageSize(message: VersionedTransaction["message"]): number {
  let size = 1;
  size += 3;
  size += shortVecSize(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length;
  size += 32; // recent blockhash

  size += shortVecSize(message.compiledInstructions.length);
  for (const instruction of message.compiledInstructions) {
    size += 1;
    size += shortVecSize(instruction.accountKeyIndexes.length) + instruction.accountKeyIndexes.length;
    size += shortVecSize(instruction.data.length) + instruction.data.length;
  }

  size += shortVecSize(message.addressTableLookups.length);
  for (const lookup of message.addressTableLookups) {
    size += 32;
    size += shortVecSize(lookup.writableIndexes.length) + lookup.writableIndexes.length;
    size += shortVecSize(lookup.readonlyIndexes.length) + lookup.readonlyIndexes.length;
  }
  return size;
}

function measure(transaction: VersionedTransaction): number {
  return messageSize(transaction.message) + signatureOverhead(transaction);
}

/**
 * A group too large to fit even alone is reported in `oversized` instead of
 * throwing, so the rest of the basket still ships.
 */
export interface PackResult {
  readonly packed: readonly PackedTransaction[];
  readonly oversized: readonly { readonly index: number; readonly bytes: number; readonly reason: string }[];
}

/**
 * Greedily packs groups in order. `preamble` (typically the compute budget) is
 * repeated in every transaction, since each executes and is priced on its own.
 */
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
