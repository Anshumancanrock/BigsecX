import { describe, expect, test } from "bun:test";
import { PYTH_FEED_IDS, PythClient, priceTruth, type OraclePrice } from "../src/pyth.ts";

const NOW = new Date("2026-09-20T12:00:00Z");
const oracle = (priceUsd: number, confidenceUsd = 1, ageSeconds = 5): OraclePrice => ({
  symbol: "OPENAI",
  priceUsd,
  confidenceUsd,
  publishedAt: new Date(NOW.getTime() - ageSeconds * 1000),
});

describe("PythClient", () => {
  test("reports itself unavailable without a key", () => {
    // Hermes rejects price reads with HTTP 401 and no key, so saying so
    // beats every request failing.
    expect(new PythClient(undefined).available).toBe(false);
    expect(new PythClient("").available).toBe(false);
    expect(new PythClient("k").available).toBe(true);
  });

  test("returns nothing rather than throwing when unavailable", async () => {
    const prices = await new PythClient(undefined).prices(["OPENAI", "ANTHROPIC"]);
    expect(prices.size).toBe(0);
  });

  test("asks for nothing when no requested symbol is covered", async () => {
    // Pyth carries three of the eight names; the rest must not produce a
    // pointless request.
    const prices = await new PythClient("key").prices(["KALSHI", "POLYMARKET"]);
    expect(prices.size).toBe(0);
  });

  test("feed ids are pinned, not resolved by search", () => {
    // Resolving by substring would let a newly listed similar feed silently
    // become the reference a price is judged against.
    expect(Object.keys(PYTH_FEED_IDS).sort()).toEqual(["ANTHROPIC", "OPENAI", "SPACEX"]);
    for (const id of Object.values(PYTH_FEED_IDS)) expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("priceTruth", () => {
  test("judges against the oracle when one exists", () => {
    // Market 1200, oracle 1000: the token is rich against an independent
    // reference, whatever the issuer says.
    const truth = priceTruth({
      symbol: "OPENAI",
      marketUsd: 1_200,
      markUsd: 1_190,
      oracle: oracle(1_000),
      now: NOW,
    });
    expect(truth.verdict).toBe("token-rich");
    expect(truth.basisToOracle).toBeCloseTo(0.2, 9);
    expect(truth.basisToMark).toBeCloseTo(1_200 / 1_190 - 1, 9);
  });

  test("falls back to the issuer mark when no oracle covers the name", () => {
    const truth = priceTruth({
      symbol: "KALSHI",
      marketUsd: 800,
      markUsd: 1_000,
      oracle: undefined,
      now: NOW,
    });
    expect(truth.verdict).toBe("token-cheap");
    expect(truth.basisToOracle).toBeNull();
    expect(truth.basisToMark).toBeCloseTo(-0.2, 9);
  });

  test("measures how far the two references disagree", () => {
    // The number that matters when they do: the reference itself is
    // uncertain, so a premium against either means less.
    const truth = priceTruth({
      symbol: "OPENAI",
      marketUsd: 1_000,
      markUsd: 1_200,
      oracle: oracle(1_000),
      now: NOW,
    });
    expect(truth.referenceSpread).toBeCloseTo(0.2, 9);
  });

  test("calls a small gap aligned", () => {
    const truth = priceTruth({
      symbol: "OPENAI",
      marketUsd: 1_010,
      markUsd: 1_000,
      oracle: oracle(1_000),
      now: NOW,
    });
    expect(truth.verdict).toBe("aligned");
  });

  test("reports oracle age and confidence for staleness checks", () => {
    const truth = priceTruth({
      symbol: "OPENAI",
      marketUsd: 1_000,
      markUsd: 1_000,
      oracle: oracle(1_000, 4.25, 90),
      now: NOW,
    });
    expect(truth.oracleAgeSeconds).toBe(90);
    expect(truth.oracleConfidenceUsd).toBeCloseTo(4.25, 9);
  });

  test("says unknown rather than guessing when there is no reference", () => {
    const truth = priceTruth({
      symbol: "OPENAI",
      marketUsd: 1_000,
      markUsd: null,
      oracle: undefined,
      now: NOW,
    });
    expect(truth.verdict).toBe("unknown");
    expect(truth.basisToMark).toBeNull();
  });

  test("does not divide by a zero reference", () => {
    const truth = priceTruth({
      symbol: "OPENAI",
      marketUsd: 1_000,
      markUsd: 0,
      oracle: undefined,
      now: NOW,
    });
    expect(truth.basisToMark).toBeNull();
    expect(truth.verdict).toBe("unknown");
  });

  test("an unpriced token has no verdict", () => {
    const truth = priceTruth({
      symbol: "OPENAI",
      marketUsd: null,
      markUsd: 1_000,
      oracle: oracle(1_000),
      now: NOW,
    });
    expect(truth.verdict).toBe("unknown");
  });
});
