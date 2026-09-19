import { describe, expect, test } from "bun:test";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { PACKET_DATA_SIZE, compileAndMeasure, packGroups } from "../src/pack.ts";
import { instructionKey, lookupTablesFrom, toInstruction } from "../src/instructions.ts";

const PAYER = new PublicKey("GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL");
const BLOCKHASH = "9C62FZuEUbpZmFrqPQbNfBiPr5U1JcTBhCfKqGgSEg4m";
const PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/** An instruction touching `accountCount` distinct accounts. */
function instruction(accountCount: number, dataBytes = 52): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: Array.from({ length: accountCount }, () => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: true,
    })),
    data: Buffer.alloc(dataBytes, 7),
  });
}

const group = (accountCount: number) => ({
  instructions: [instruction(accountCount)],
  lookupTables: [],
});

describe("compileAndMeasure", () => {
  test("measures a transaction that is over the wire limit instead of throwing", () => {
    // web3.js serialize() encodes into a fixed 1232-byte buffer and throws
    // past it; the packer has to know the real size to make a decision.
    const measured = compileAndMeasure({
      payer: PAYER,
      blockhash: BLOCKHASH,
      instructions: [instruction(60)],
      lookupTables: [],
    });
    expect(measured).not.toBeNull();
    expect(measured!.bytes).toBeGreaterThan(PACKET_DATA_SIZE);
  });

  test("a small transaction measures under the limit", () => {
    const measured = compileAndMeasure({
      payer: PAYER,
      blockhash: BLOCKHASH,
      instructions: [instruction(4)],
      lookupTables: [],
    });
    expect(measured!.bytes).toBeLessThan(PACKET_DATA_SIZE);
  });

  test("the measured size accounts for unsigned signature slots", () => {
    const measured = compileAndMeasure({
      payer: PAYER,
      blockhash: BLOCKHASH,
      instructions: [instruction(1)],
      lookupTables: [],
    });
    // 1 signature slot (64) + its length prefix must be included.
    expect(measured!.bytes).toBeGreaterThan(measured!.transaction.message.serialize().length + 64);
  });
});

describe("packGroups", () => {
  test("combines small groups into one transaction", () => {
    const { packed, oversized } = packGroups({
      payer: PAYER,
      blockhash: BLOCKHASH,
      groups: [group(3), group(3), group(3)],
    });
    expect(oversized).toHaveLength(0);
    expect(packed).toHaveLength(1);
    expect(packed[0]?.groupIndices).toEqual([0, 1, 2]);
  });

  test("splits into more transactions as groups grow", () => {
    const { packed, oversized } = packGroups({
      payer: PAYER,
      blockhash: BLOCKHASH,
      groups: [group(14), group(14), group(14), group(14)],
    });
    expect(oversized).toHaveLength(0);
    expect(packed.length).toBeGreaterThan(1);
    // Every group is placed exactly once, in order.
    expect(packed.flatMap((p) => p.groupIndices)).toEqual([0, 1, 2, 3]);
  });

  test("every packed transaction stays inside the wire limit", () => {
    const { packed } = packGroups({
      payer: PAYER,
      blockhash: BLOCKHASH,
      groups: Array.from({ length: 8 }, () => group(12)),
    });
    for (const entry of packed) expect(entry.byteLength).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  test("reports an unroutable group rather than throwing away the basket", () => {
    const { packed, oversized } = packGroups({
      payer: PAYER,
      blockhash: BLOCKHASH,
      groups: [group(3), group(80), group(3)],
    });
    expect(oversized.map((o) => o.index)).toEqual([1]);
    expect(oversized[0]?.bytes).toBeGreaterThan(PACKET_DATA_SIZE);
    // The viable groups still ship.
    expect(packed.flatMap((p) => p.groupIndices).sort()).toEqual([0, 2]);
  });

  test("carries the preamble into every transaction", () => {
    const preamble = [instruction(1, 5)];
    const { packed } = packGroups({
      payer: PAYER,
      blockhash: BLOCKHASH,
      groups: Array.from({ length: 6 }, () => group(14)),
      preamble,
    });
    expect(packed.length).toBeGreaterThan(1);
    for (const entry of packed) {
      // Instructions are returned without the preamble so the caller can
      // re-apply a corrected one; the compiled transaction includes it.
      expect(entry.transaction.message.compiledInstructions.length).toBe(
        entry.instructions.length + preamble.length,
      );
    }
  });

  test("returns nothing for no groups", () => {
    const { packed, oversized } = packGroups({ payer: PAYER, blockhash: BLOCKHASH, groups: [] });
    expect(packed).toHaveLength(0);
    expect(oversized).toHaveLength(0);
  });
});

describe("instruction adapters", () => {
  test("round-trips a Jupiter instruction", () => {
    const source = {
      programId: PROGRAM.toBase58(),
      accounts: [{ pubkey: PAYER.toBase58(), isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3]).toString("base64"),
    };
    const converted = toInstruction(source);
    expect(converted.programId.equals(PROGRAM)).toBe(true);
    expect(converted.keys[0]?.isSigner).toBe(true);
    expect([...converted.data]).toEqual([1, 2, 3]);
  });

  test("identical setup instructions share a key so duplicates can be dropped", () => {
    const source = {
      programId: PROGRAM.toBase58(),
      accounts: [{ pubkey: PAYER.toBase58(), isSigner: false, isWritable: true }],
      data: "AQID",
    };
    expect(instructionKey(source)).toBe(instructionKey({ ...source }));
    expect(instructionKey(source)).not.toBe(instructionKey({ ...source, data: "BAUG" }));
  });

  test("rebuilds lookup tables from the inline address map", () => {
    const table = Keypair.generate().publicKey.toBase58();
    const addresses = [PAYER.toBase58(), PROGRAM.toBase58()];
    const tables = lookupTablesFrom({
      tokenLedgerInstruction: null,
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: { programId: PROGRAM.toBase58(), accounts: [], data: "" },
      cleanupInstruction: null,
      otherInstructions: [],
      addressLookupTableAddresses: [table],
      addressesByLookupTableAddress: { [table]: addresses },
    });
    expect(tables).toHaveLength(1);
    expect(tables[0]).toBeInstanceOf(AddressLookupTableAccount);
    expect(tables[0]?.state.addresses.map((a) => a.toBase58())).toEqual(addresses);
    // A table must read as active or the compiler will ignore it.
    expect(tables[0]?.isActive()).toBe(true);
  });

  test("returns no tables when the map is absent", () => {
    const tables = lookupTablesFrom({
      tokenLedgerInstruction: null,
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: { programId: PROGRAM.toBase58(), accounts: [], data: "" },
      cleanupInstruction: null,
      otherInstructions: [],
      addressLookupTableAddresses: [],
    });
    expect(tables).toHaveLength(0);
  });
});
