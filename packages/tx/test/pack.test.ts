import { describe, expect, test } from "bun:test";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { PACKET_DATA_SIZE, compileAndMeasure, packGroups } from "../src/pack.ts";
import { findUncoveredSells } from "../src/holdings.ts";
import {
  dedupeWithinTransaction,
  instructionKey,
  lookupTablesFrom,
  toInstruction,
} from "../src/instructions.ts";

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

describe("setup instructions across a multi-transaction bundle", () => {
  /**
   * Regression test for a bug that shipped.
   *
   * Setup instructions were deduplicated across the whole bundle, so the
   * "create the USDC destination account" instruction that every sell leg
   * emits was kept in the first leg's group and dropped from the rest. Those
   * groups pack into different transactions, so a wallet without a USDC
   * account would have the first transaction create it and every later one
   * fail against an account that did not exist yet.
   */
  const SETUP_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const DESTINATION = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  /** The shared idempotent account creation every sell leg emits. */
  function sharedSetup(): TransactionInstruction {
    return new TransactionInstruction({
      programId: SETUP_PROGRAM,
      keys: [{ pubkey: DESTINATION, isSigner: false, isWritable: true }],
      data: Buffer.from([1]), // CreateIdempotent
    });
  }

  const isSetup = (i: TransactionInstruction) => i.programId.equals(SETUP_PROGRAM);

  test("every transaction keeps the setup its legs depend on", () => {
    // Legs large enough that they cannot share one transaction.
    const groups = Array.from({ length: 4 }, () => ({
      instructions: [sharedSetup(), instruction(16)],
      lookupTables: [],
    }));

    const { packed, oversized } = packGroups({ payer: PAYER, blockhash: BLOCKHASH, groups });
    expect(oversized).toHaveLength(0);
    expect(packed.length).toBeGreaterThan(1);

    for (const entry of packed) {
      const kept = dedupeWithinTransaction(entry.instructions);
      expect(kept.filter(isSetup)).toHaveLength(1);
    }
  });

  test("legs sharing a transaction carry the setup only once", () => {
    const groups = Array.from({ length: 3 }, () => ({
      instructions: [sharedSetup(), instruction(2)],
      lookupTables: [],
    }));

    const { packed } = packGroups({ payer: PAYER, blockhash: BLOCKHASH, groups });
    expect(packed).toHaveLength(1);

    const kept = dedupeWithinTransaction(packed[0]!.instructions);
    expect(kept.filter(isSetup)).toHaveLength(1);
    // The three swaps survive; only the repeated setup is collapsed.
    expect(kept.filter((i) => !isSetup(i))).toHaveLength(3);
  });

  test("dedupe is keyed on accounts and data, not just program", () => {
    const other = new TransactionInstruction({
      programId: SETUP_PROGRAM,
      keys: [{ pubkey: PROGRAM, isSigner: false, isWritable: true }],
      data: Buffer.from([1]),
    });
    expect(dedupeWithinTransaction([sharedSetup(), other, sharedSetup()])).toHaveLength(2);
  });
});

describe("sell coverage", () => {
  const balance = (uiAmount: number, frozen = false) =>
    new Map([["OPENAI", { symbol: "OPENAI", uiAmount, rawAmount: 0n, frozen }]]);
  const prices = new Map([["OPENAI", 100]]);

  test("refuses a leg that exceeds the balance", () => {
    // Regression: a one percent tolerance let a leg one percent over the
    // balance through, and it then failed on chain with 0x1788 after the
    // user had signed. A guard that permits the failure it exists to prevent
    // is worse than none.
    const legs = [{ symbol: "OPENAI", side: "sell" as const, usd: 10_100 }];
    expect(findUncoveredSells(legs, balance(100), prices)).toHaveLength(1);
  });

  test("allows a leg that exactly matches the balance", () => {
    const legs = [{ symbol: "OPENAI", side: "sell" as const, usd: 10_000 }];
    expect(findUncoveredSells(legs, balance(100), prices)).toHaveLength(0);
  });

  test("refuses a frozen account however much it reports", () => {
    // The issuer holds freeze authority on every mint. A frozen account
    // still reports its full balance.
    const legs = [{ symbol: "OPENAI", side: "sell" as const, usd: 100 }];
    const result = findUncoveredSells(legs, balance(100, true), prices);
    expect(result).toHaveLength(1);
    expect(result[0]?.frozen).toBe(true);
    expect(result[0]?.availableUsd).toBe(0);
  });

  test("ignores buy legs", () => {
    const legs = [{ symbol: "OPENAI", side: "buy" as const, usd: 1e9 }];
    expect(findUncoveredSells(legs, balance(0), prices)).toHaveLength(0);
  });
});
