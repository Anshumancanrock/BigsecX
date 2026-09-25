import { describe, expect, test } from "bun:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { sameBytes, splitTransaction } from "../src/lib/vtx.ts";

const BLOCKHASH = "9C62FZuEUbpZmFrqPQbNfBiPr5U1JcTBhCfKqGgSEg4m";

function build(options: { payer?: Keypair; lamports?: number; sign?: boolean } = {}) {
  const payer = options.payer ?? Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: options.lamports ?? 1_000,
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (options.sign !== false) tx.sign([payer]);
  return { payer, tx, bytes: new Uint8Array(tx.serialize()), message };
}

describe("splitTransaction", () => {
  test("separates signatures from the message on a real transaction", () => {
    const { tx, bytes, message } = build();
    const split = splitTransaction(bytes);
    expect(split.signatureCount).toBe(1);
    expect(split.signatures.length).toBe(64);
    // The message half must match web3.js's own serialisation of the message.
    expect([...split.message]).toEqual([...message.serialize()]);
    expect([...split.signatures]).toEqual([...tx.signatures[0]!]);
  });

  test("the message is identical before and after signing", () => {
    // This is the property the wallet check relies on: signing changes only
    // the signature section.
    const payer = Keypair.generate();
    const unsigned = build({ payer, sign: false });
    const signed = build({ payer, sign: true });
    // Rebuild the same transaction and sign it, rather than two randoms.
    const tx = VersionedTransaction.deserialize(unsigned.bytes);
    tx.sign([payer]);
    const after = splitTransaction(new Uint8Array(tx.serialize()));
    expect(sameBytes(splitTransaction(unsigned.bytes).message, after.message)).toBe(true);
    expect(sameBytes(splitTransaction(unsigned.bytes).signatures, after.signatures)).toBe(false);
    expect(signed.bytes.length).toBeGreaterThan(0);
  });

  test("a changed amount changes the message, which is the whole point", () => {
    const payer = Keypair.generate();
    const a = splitTransaction(build({ payer, lamports: 1_000 }).bytes);
    const b = splitTransaction(build({ payer, lamports: 9_999 }).bytes);
    expect(sameBytes(a.message, b.message)).toBe(false);
  });

  test("decodes a multi-byte compact-u16 signature count", () => {
    // 128 signatures encode as two bytes. Real transactions carry one, but a
    // wrong length here would compare the wrong byte range.
    const bytes = new Uint8Array(2 + 128 * 64 + 5);
    bytes[0] = 0x80;
    bytes[1] = 0x01;
    bytes.fill(7, 2 + 128 * 64);
    const split = splitTransaction(bytes);
    expect(split.signatureCount).toBe(128);
    expect(split.signatures.length).toBe(128 * 64);
    expect([...split.message]).toEqual([7, 7, 7, 7, 7]);
  });

  test("refuses bytes that claim more signatures than they carry", () => {
    const bytes = new Uint8Array([3, 1, 2, 3]);
    expect(() => splitTransaction(bytes)).toThrow("shorter than its signature count");
  });

  test("sameBytes is exact about length and content", () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});
