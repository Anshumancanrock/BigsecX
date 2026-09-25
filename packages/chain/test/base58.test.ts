import { describe, expect, test } from "bun:test";
import { PublicKey, Keypair } from "@solana/web3.js";
import { decodeBase58, encodeBase58, isBase58Address } from "../src/base58.ts";

describe("base58", () => {
  test("matches the published Bitcoin test vectors", () => {
    const vectors: [number[], string][] = [
      [[], ""],
      [[0x61], "2g"],
      [[0x62, 0x62, 0x62], "a3gV"],
      [[0x63, 0x63, 0x63], "aPEr"],
      [[0x00, 0x00, 0x00, 0x28, 0x7f, 0xb4, 0xcd], "111233QC4"],
      [[0x00, 0x61], "12g"],
      [[0xff], "5Q"],
      [[0xff, 0xff], "LUv"],
    ];
    for (const [bytes, expected] of vectors) {
      expect(encodeBase58(Uint8Array.from(bytes))).toBe(expected);
      expect([...decodeBase58(expected)]).toEqual(bytes);
    }
  });

  test("agrees with PublicKey.toBase58 over random 32-byte keys", () => {
    for (let i = 0; i < 200; i++) {
      const key = Keypair.generate().publicKey;
      expect(encodeBase58(key.toBytes())).toBe(key.toBase58());
      expect([...decodeBase58(key.toBase58())]).toEqual([...key.toBytes()]);
    }
  });

  test("round-trips 64-byte signatures, the other thing Solana base58-encodes", () => {
    for (let i = 0; i < 100; i++) {
      const signature = crypto.getRandomValues(new Uint8Array(64));
      expect([...decodeBase58(encodeBase58(signature))]).toEqual([...signature]);
    }
  });

  test("preserves leading zero bytes, which the integer conversion drops", () => {
    const bytes = new Uint8Array(32);
    bytes[31] = 1;
    const encoded = encodeBase58(bytes);
    expect(encoded.startsWith("1111")).toBe(true);
    expect(decodeBase58(encoded).length).toBe(32);
    expect(new PublicKey(bytes).toBase58()).toBe(encoded);
  });

  test("rejects characters outside the alphabet", () => {
    for (const bad of ["0", "O", "I", "l", "abc!", "hello world", "é"]) {
      expect(() => decodeBase58(bad)).toThrow();
    }
  });

  test("isBase58Address accepts real keys and rejects near-misses", () => {
    expect(isBase58Address(Keypair.generate().publicKey.toBase58())).toBe(true);
    expect(isBase58Address("PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF")).toBe(true);
    expect(isBase58Address("")).toBe(false);
    expect(isBase58Address("tooshort")).toBe(false);
    expect(isBase58Address("0".repeat(40))).toBe(false);
    expect(isBase58Address("1".repeat(45))).toBe(false);
  });
});
