import { describe, expect, test } from "bun:test";
import { feeChangeWords, feePercent, feeWords } from "../src/lib/words.ts";

describe("fee words", () => {
  test("say the fee as a percentage", () => {
    expect(feePercent(100)).toBe("1%");
    expect(feePercent(50)).toBe("0.5%");
    expect(feeWords(300)).toBe("3% fee on every buy and sell");
  });

  test("say a scheduled rise, from the shape the market route sends", () => {
    // Mainnet schedule read during epoch 1042: 1% rising to 3% at epoch 1043.
    const change = { fromBps: 100, toBps: 300, atEpoch: 1043 };
    expect(feeChangeWords(change, 1042)).toBe(
      "The issuer's fee rises from 1% to 3% at the next epoch, within about two days.",
    );
    expect(feeChangeWords(change, 1040)).toBe("The issuer's fee rises from 1% to 3% at epoch 1043.");
  });

  test("say nothing when no change is coming", () => {
    expect(feeChangeWords(null, 1042)).toBeNull();
    expect(feeChangeWords(undefined, undefined)).toBeNull();
  });
});
