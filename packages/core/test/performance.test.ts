import { describe, expect, test } from "bun:test";
import { computePerformance, rankWallets, type RankedWallet } from "../src/performance.ts";

const flat = new Map([["OPENAI", 1_000], ["SPACEX", 100]]);

describe("computePerformance", () => {
  test("price appreciation with no trading is pure return", () => {
    const result = computePerformance({
      before: [{ symbol: "OPENAI", uiAmount: 1 }],
      after: [{ symbol: "OPENAI", uiAmount: 1 }],
      priceBefore: new Map([["OPENAI", 1_000]]),
      priceAfter: new Map([["OPENAI", 1_100]]),
    });
    expect(result.netFlowUsd).toBe(0);
    expect(result.returnFraction).toBeCloseTo(0.1, 12);
  });

  test("a deposit is not counted as performance", () => {
    // Value doubles, but only because a second share was deposited.
    const result = computePerformance({
      before: [{ symbol: "OPENAI", uiAmount: 1 }],
      after: [{ symbol: "OPENAI", uiAmount: 2 }],
      priceBefore: new Map([["OPENAI", 1_000]]),
      priceAfter: new Map([["OPENAI", 1_000]]),
    });
    expect(result.valueAfter).toBe(2_000);
    expect(result.netFlowUsd).toBe(1_000);
    expect(result.returnFraction).toBeCloseTo(0, 12);
  });

  test("a withdrawal is not counted as a loss", () => {
    const result = computePerformance({
      before: [{ symbol: "OPENAI", uiAmount: 2 }],
      after: [{ symbol: "OPENAI", uiAmount: 1 }],
      priceBefore: new Map([["OPENAI", 1_000]]),
      priceAfter: new Map([["OPENAI", 1_000]]),
    });
    expect(result.netFlowUsd).toBe(-1_000);
    expect(result.returnFraction).toBeCloseTo(0, 12);
  });

  test("a switch between names nets to roughly no flow", () => {
    // Sell 1 OPENAI at 1000, buy 10 SPACEX at 100. Prices unchanged.
    const result = computePerformance({
      before: [{ symbol: "OPENAI", uiAmount: 1 }],
      after: [{ symbol: "SPACEX", uiAmount: 10 }],
      priceBefore: flat,
      priceAfter: flat,
    });
    expect(result.netFlowUsd).toBeCloseTo(0, 9);
    expect(result.returnFraction).toBeCloseTo(0, 9);
  });

  test("a good switch shows up as return", () => {
    // Rotated into SPACEX, which then rose 20%.
    const result = computePerformance({
      before: [{ symbol: "OPENAI", uiAmount: 1 }],
      after: [{ symbol: "SPACEX", uiAmount: 10 }],
      priceBefore: flat,
      priceAfter: new Map([["OPENAI", 1_000], ["SPACEX", 120]]),
    });
    // Flow is valued at the midpoint price of 110, so the measured return is
    // the part the midpoint convention attributes to holding.
    expect(result.returnFraction).toBeGreaterThan(0);
    expect(result.valueAfter).toBe(1_200);
  });

  test("reports no return rather than infinity from an empty start", () => {
    const result = computePerformance({
      before: [],
      after: [{ symbol: "OPENAI", uiAmount: 1 }],
      priceBefore: flat,
      priceAfter: flat,
    });
    expect(result.returnFraction).toBeNull();
  });

  test("values a flow with whatever price is available", () => {
    // A newly listed token has no earlier price; the flow still has to be
    // removed or it reads as pure gain.
    const result = computePerformance({
      before: [{ symbol: "OPENAI", uiAmount: 1 }],
      after: [{ symbol: "OPENAI", uiAmount: 1 }, { symbol: "NEW", uiAmount: 5 }],
      priceBefore: new Map([["OPENAI", 1_000]]),
      priceAfter: new Map([["OPENAI", 1_000], ["NEW", 50]]),
    });
    expect(result.netFlowUsd).toBe(250);
    expect(result.returnFraction).toBeCloseTo(0, 12);
  });
});

describe("rankWallets", () => {
  const wallet = (owner: string, before: number, after: number): RankedWallet => ({
    owner,
    positions: [],
    performance: {
      valueBefore: before,
      valueAfter: after,
      netFlowUsd: 0,
      returnFraction: before > 0 ? after / before - 1 : null,
    },
  });

  test("ranks by return, best first", () => {
    const ranked = rankWallets([
      wallet("a", 10_000, 11_000),
      wallet("b", 10_000, 13_000),
      wallet("c", 10_000, 9_000),
    ]);
    expect(ranked.map((w) => w.owner)).toEqual(["b", "a", "c"]);
  });

  test("drops dust portfolios that would otherwise top the board", () => {
    const ranked = rankWallets([wallet("dust", 12, 120), wallet("real", 10_000, 11_000)]);
    expect(ranked.map((w) => w.owner)).toEqual(["real"]);
  });

  test("drops wallets with no measurable return", () => {
    const ranked = rankWallets([wallet("fresh", 0, 50_000)]);
    expect(ranked).toHaveLength(0);
  });

  test("honours the limit", () => {
    const many = Array.from({ length: 80 }, (_, i) => wallet(`w${i}`, 10_000, 10_000 + i));
    expect(rankWallets(many, { limit: 10 })).toHaveLength(10);
  });
});
