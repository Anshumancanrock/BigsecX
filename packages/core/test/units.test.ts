import { describe, expect, test } from "bun:test";
import {
  UNSCALED,
  currentMultiplier,
  rawPriceToUiPrice,
  rawToUi,
  uiToRaw,
  type ScaledUiAmountConfig,
} from "../src/units.ts";

/** OPENAI mint, read from mainnet on 2026-09-19. */
const OPENAI: ScaledUiAmountConfig = {
  multiplier: 1,
  newMultiplier: 1.4861347,
  newMultiplierEffectiveTimestamp: 1784305800,
};

/** SPACEX mint: a 5:1 split, already in force. */
const SPACEX: ScaledUiAmountConfig = {
  multiplier: 1,
  newMultiplier: 5,
  newMultiplierEffectiveTimestamp: 1781065800,
};

const NOW = 1789814825; // 2026-09-19, after both effective timestamps

describe("currentMultiplier", () => {
  // Vectors transcribed from the `multiplier_choice` test in
  // spl-token-2022/interface/src/extension/scaled_ui_amount/mod.rs
  const config: ScaledUiAmountConfig = {
    multiplier: 5,
    newMultiplier: 10,
    newMultiplierEffectiveTimestamp: 1,
  };

  test("takes the new multiplier from the effective second onward", () => {
    expect(currentMultiplier(config, 1)).toBe(10);
  });

  test("takes the old multiplier strictly before it", () => {
    expect(currentMultiplier(config, 0)).toBe(5);
  });

  test("saturates in both directions", () => {
    expect(currentMultiplier(config, Number.MIN_SAFE_INTEGER)).toBe(5);
    expect(currentMultiplier(config, Number.MAX_SAFE_INTEGER)).toBe(10);
  });

  test("a scheduled split is not applied early", () => {
    expect(currentMultiplier(OPENAI, OPENAI.newMultiplierEffectiveTimestamp - 1)).toBe(1);
    expect(currentMultiplier(OPENAI, OPENAI.newMultiplierEffectiveTimestamp)).toBe(1.4861347);
  });
});

describe("rawToUi", () => {
  test("reproduces the live OPENAI supply reported by the issuer API", () => {
    // Mint supply 1901899847455 raw at 9 decimals; the issuer reports 2826.48
    // UI shares. Agreement here is what proves the multiplier is applied.
    const ui = rawToUi(1901899847455n, 9, OPENAI, NOW);
    expect(ui).toBeCloseTo(2826.479359227, 6);
  });

  test("reproduces the live SPACEX supply", () => {
    const ui = rawToUi(8742515265119n, 9, SPACEX, NOW);
    expect(ui).toBeCloseTo(43712.576325595, 6);
  });

  test("is the identity for an unscaled mint", () => {
    expect(rawToUi(7381896595230n, 9, UNSCALED, NOW)).toBeCloseTo(7381.89659523, 6);
  });

  test("truncates after scaling, not before", () => {
    // 3 raw units at x1.5 is 4.5 scaled, which truncates to 4 -- not to 3x1.5
    // rounded, and not to trunc(3)x1.5.
    const half: ScaledUiAmountConfig = { ...UNSCALED, multiplier: 1.5, newMultiplier: 1.5 };
    expect(rawToUi(3n, 0, half, NOW)).toBe(4);
  });

  test("zero maps to zero under any multiplier", () => {
    expect(rawToUi(0n, 9, SPACEX, NOW)).toBe(0);
  });
});

describe("uiToRaw", () => {
  test("round-trips the live OPENAI supply", () => {
    const raw = uiToRaw(rawToUi(1901899847455n, 9, OPENAI, NOW), 9, OPENAI, NOW);
    // Truncation costs at most one base unit, which is 1e-9 of a share.
    expect(Number(1901899847455n - raw)).toBeLessThanOrEqual(1);
  });

  test("round-trips SPACEX", () => {
    const raw = uiToRaw(rawToUi(8742515265119n, 9, SPACEX, NOW), 9, SPACEX, NOW);
    expect(Number(8742515265119n - raw)).toBeLessThanOrEqual(1);
  });

  test("one UI share of SPACEX is a fifth of a raw token", () => {
    expect(uiToRaw(1, 9, SPACEX, NOW)).toBe(200_000_000n);
  });

  test("rejects values that cannot be represented", () => {
    expect(() => uiToRaw(Number.POSITIVE_INFINITY, 9, SPACEX, NOW)).toThrow(RangeError);
    expect(() => uiToRaw(-1, 9, SPACEX, NOW)).toThrow(RangeError);
  });
});

describe("rawPriceToUiPrice", () => {
  test("corrects the OPENAI price a naive Jupiter read produces", () => {
    // $1000 USDC quoted 585525247 raw base units, i.e. $1707.87 per raw token.
    // The issuer's own token price at that moment was $1135.02.
    const rawPrice = 1000 / (585525247 / 1e9);
    expect(rawPrice).toBeCloseTo(1707.87, 1);

    const uiPrice = rawPriceToUiPrice(rawPrice, OPENAI, NOW);
    expect(uiPrice).toBeCloseTo(1149.19, 1);
    // Within spread of the issuer price, whereas the raw figure is 50% off.
    expect(Math.abs(uiPrice / 1135.02 - 1)).toBeLessThan(0.02);
  });

  test("corrects SPACEX, where the naive error is 400%", () => {
    const rawPrice = 585.88;
    expect(rawPriceToUiPrice(rawPrice, SPACEX, NOW)).toBeCloseTo(117.18, 2);
  });
});
