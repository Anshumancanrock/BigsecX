import { describe, expect, test } from "bun:test";
import { fromBase64, toBase58, toBase64, utf8 } from "../src/lib/bytes.ts";

describe("bytes", () => {
  test("round-trips a full-size transaction", () => {
    // 1232 bytes is the wire limit, and the chunked encoder exists precisely
    // because a spread of this many arguments is engine-dependent.
    const bytes = crypto.getRandomValues(new Uint8Array(1232));
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  test("round-trips sizes that straddle the 0x8000 chunk boundary", () => {
    for (const size of [0, 1, 2, 3, 32767, 32768, 32769, 70000]) {
      const bytes = new Uint8Array(size).map((_, i) => i % 256);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  test("handles every byte value, including the ones that break naive string paths", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  test("agrees with the platform encoder", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(500));
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  test("toBase58 matches the server's encoder on signature-sized input", async () => {
    const { encodeBase58 } = await import("../../../packages/chain/src/base58.ts");
    for (let i = 0; i < 50; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(64));
      expect(toBase58(bytes)).toBe(encodeBase58(bytes));
    }
    // Leading zeros are the classic divergence.
    const leading = new Uint8Array(64);
    leading[63] = 9;
    expect(toBase58(leading)).toBe(encodeBase58(leading));
  });

  test("utf8 encodes beyond ASCII, since a signed message may contain anything", () => {
    expect([...utf8("a")]).toEqual([97]);
    expect(new TextDecoder().decode(utf8("prestocks.basket\nwallet:é"))).toBe(
      "prestocks.basket\nwallet:é",
    );
  });
});

import { list } from "../src/lib/format.ts";

describe("list", () => {
  test("passes arrays through untouched", () => {
    const xs = [1, 2, 3];
    expect(list(xs)).toBe(xs);
    expect(list([])).toEqual([]);
  });

  test("turns anything that is not an array into an empty one", () => {
    // The point: a response of the wrong shape must not take a page down.
    // Every one of these came from a real malformed-response test.
    for (const bad of [null, undefined, "not an array", 42, {}, { length: 3 }, true]) {
      expect(list(bad as never)).toEqual([]);
    }
  });

  test("the result is always safe to map, index and measure", () => {
    const bad = list(null as never);
    expect(bad.length).toBe(0);
    expect(bad[0]).toBeUndefined();
    expect(bad.map((x) => x)).toEqual([]);
    expect(bad.filter(Boolean)).toEqual([]);
    expect(bad.find(() => true)).toBeUndefined();
  });
});
