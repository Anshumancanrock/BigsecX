import { describe, expect, test } from "bun:test";
import {
  capWeights,
  currentWeights,
  drift,
  normalizeWeights,
  planRebalance,
  type Weight,
} from "../src/portfolio.ts";

const sum = (weights: readonly Weight[]) => weights.reduce((s, w) => s + w.weight, 0);

describe("normalizeWeights", () => {
  test("rescales to sum to one", () => {
    const out = normalizeWeights([
      { symbol: "A", weight: 3 },
      { symbol: "B", weight: 1 },
    ]);
    expect(sum(out)).toBeCloseTo(1, 12);
    expect(out.find((w) => w.symbol === "A")?.weight).toBeCloseTo(0.75, 12);
  });

  test("drops zero and negative weights", () => {
    const out = normalizeWeights([
      { symbol: "A", weight: 1 },
      { symbol: "B", weight: 0 },
      { symbol: "C", weight: -2 },
    ]);
    expect(out).toHaveLength(1);
  });

  test("fails loudly rather than allocating nothing", () => {
    expect(() => normalizeWeights([{ symbol: "A", weight: 0 }])).toThrow(RangeError);
    expect(() => normalizeWeights([])).toThrow(RangeError);
  });
});

describe("capWeights", () => {
  test("caps a dominant position and redistributes the excess", () => {
    const out = capWeights(
      [
        { symbol: "BIG", weight: 90 },
        { symbol: "A", weight: 5 },
        { symbol: "B", weight: 5 },
      ],
      0.5,
    );
    expect(sum(out)).toBeCloseTo(1, 12);
    expect(out.find((w) => w.symbol === "BIG")?.weight).toBeCloseTo(0.5, 12);
    // The freed weight splits in proportion to the uncapped names, which were
    // equal, so they end up equal.
    expect(out.find((w) => w.symbol === "A")?.weight).toBeCloseTo(0.25, 12);
  });

  test("handles a second name breaching the cap after redistribution", () => {
    const out = capWeights(
      [
        { symbol: "BIG", weight: 80 },
        { symbol: "MID", weight: 19 },
        { symbol: "SMALL", weight: 1 },
      ],
      0.4,
    );
    expect(sum(out)).toBeCloseTo(1, 12);
    for (const w of out) expect(w.weight).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  test("rejects a cap no allocation could satisfy", () => {
    // Two positions cannot both sit under 25%.
    expect(() =>
      capWeights([{ symbol: "A", weight: 1 }, { symbol: "B", weight: 1 }], 0.25),
    ).toThrow(RangeError);
  });

  test("leaves an already-compliant allocation alone", () => {
    const out = capWeights([{ symbol: "A", weight: 1 }, { symbol: "B", weight: 1 }], 0.9);
    expect(out.find((w) => w.symbol === "A")?.weight).toBeCloseTo(0.5, 12);
  });
});

describe("currentWeights", () => {
  const prices = new Map([["OPENAI", 1000], ["SPACEX", 100]]);

  test("values holdings and expresses them as weights", () => {
    const { weights, totalUsd } = currentWeights(
      [{ symbol: "OPENAI", uiAmount: 1 }, { symbol: "SPACEX", uiAmount: 10 }],
      prices,
    );
    expect(totalUsd).toBe(2000);
    expect(weights.find((w) => w.symbol === "OPENAI")?.weight).toBeCloseTo(0.5, 12);
  });

  test("an unpriced holding contributes nothing rather than crashing", () => {
    const { totalUsd } = currentWeights([{ symbol: "UNKNOWN", uiAmount: 5 }], prices);
    expect(totalUsd).toBe(0);
  });
});

describe("drift", () => {
  test("reports a position the target does not hold as fully overweight", () => {
    const rows = drift(
      [{ symbol: "A", weight: 1 }],
      [{ symbol: "B", weight: 1 }],
    );
    expect(rows.find((r) => r.symbol === "A")?.drift).toBe(-1);
    expect(rows.find((r) => r.symbol === "B")?.drift).toBe(1);
  });

  test("orders by magnitude so the worst gap reads first", () => {
    const rows = drift(
      [{ symbol: "A", weight: 0.5 }, { symbol: "B", weight: 0.5 }],
      [{ symbol: "A", weight: 0.9 }, { symbol: "B", weight: 0.1 }],
    );
    expect(rows[0] && Math.abs(rows[0].drift)).toBeCloseTo(0.4, 12);
  });
});

describe("planRebalance", () => {
  const prices = new Map([["OPENAI", 1000], ["ANTHROPIC", 1000], ["SPACEX", 100]]);
  const target = [
    { symbol: "OPENAI", weight: 0.5 },
    { symbol: "ANTHROPIC", weight: 0.5 },
  ];

  test("deploying fresh capital into an empty wallet buys the target", () => {
    const plan = planRebalance({ target, holdings: [], priceUsdBySymbol: prices, deployUsd: 1000 });
    expect(plan.targetValueUsd).toBe(1000);
    expect(plan.orders).toHaveLength(2);
    for (const order of plan.orders) {
      expect(order.side).toBe("buy");
      expect(order.usd).toBeCloseTo(500, 9);
    }
  });

  test("emits sells before buys so the buys are funded", () => {
    const plan = planRebalance({
      target,
      holdings: [{ symbol: "SPACEX", uiAmount: 10 }], // $1000, entirely untargeted
      priceUsdBySymbol: prices,
    });
    expect(plan.orders[0]?.side).toBe("sell");
    expect(plan.orders[0]?.symbol).toBe("SPACEX");
    expect(plan.orders.filter((o) => o.side === "buy")).toHaveLength(2);
  });

  test("leaves an on-target portfolio alone", () => {
    const plan = planRebalance({
      target,
      holdings: [
        { symbol: "OPENAI", uiAmount: 0.5 },
        { symbol: "ANTHROPIC", uiAmount: 0.5 },
      ],
      priceUsdBySymbol: prices,
    });
    expect(plan.orders).toHaveLength(0);
  });

  test("ignores drift inside the tolerance band", () => {
    // 51/49 against a 50/50 target is 100bps of drift.
    const plan = planRebalance({
      target,
      holdings: [
        { symbol: "OPENAI", uiAmount: 0.51 },
        { symbol: "ANTHROPIC", uiAmount: 0.49 },
      ],
      priceUsdBySymbol: prices,
      toleranceBps: 200,
      minTicketUsd: 0,
    });
    expect(plan.orders).toHaveLength(0);
    expect(plan.skipped.every((s) => s.reason === "within tolerance")).toBe(true);
  });

  test("acts on the same drift once tolerance is tightened", () => {
    const plan = planRebalance({
      target,
      holdings: [
        { symbol: "OPENAI", uiAmount: 0.51 },
        { symbol: "ANTHROPIC", uiAmount: 0.49 },
      ],
      priceUsdBySymbol: prices,
      toleranceBps: 50,
      minTicketUsd: 0,
    });
    expect(plan.orders).toHaveLength(2);
  });

  test("skips legs too small to be worth their fee", () => {
    const plan = planRebalance({
      target,
      holdings: [],
      priceUsdBySymbol: prices,
      deployUsd: 6, // $3 per leg
      minTicketUsd: 5,
      toleranceBps: 0,
    });
    expect(plan.orders).toHaveLength(0);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped[0]?.reason).toBe("below minimum ticket");
  });

  test("can be told to keep positions outside the target", () => {
    const plan = planRebalance({
      target,
      holdings: [{ symbol: "SPACEX", uiAmount: 10 }],
      priceUsdBySymbol: prices,
      liquidateUntargeted: false,
    });
    expect(plan.orders.some((o) => o.symbol === "SPACEX")).toBe(false);
  });

  test("tops up a portfolio that is already exactly at target", () => {
    // Regression. The churn guard used to compare the held weight, a share of
    // the CURRENT book, against the target weight, a share of the book after
    // new capital lands. Those sit on different bases, so deployUsd never
    // reached the test: a wallet already at target had a gap of exactly zero
    // and every leg was discarded however much was being deployed. This is
    // the top-up path, the most common repeat action a user has, and it
    // surfaced as HTTP 400 "nothing to trade".
    const plan = planRebalance({
      target,
      holdings: [
        { symbol: "OPENAI", uiAmount: 0.5 },
        { symbol: "ANTHROPIC", uiAmount: 0.5 },
      ],
      priceUsdBySymbol: prices,
      deployUsd: 1_000,
    });

    expect(plan.orders).toHaveLength(2);
    expect(plan.orders.every((o) => o.side === "buy")).toBe(true);
    for (const order of plan.orders) expect(order.usd).toBeCloseTo(500, 9);
    expect(plan.skipped).toHaveLength(0);
  });

  test("a top-up reports the dilution, not a flat weight", () => {
    const plan = planRebalance({
      target,
      holdings: [
        { symbol: "OPENAI", uiAmount: 0.5 },
        { symbol: "ANTHROPIC", uiAmount: 0.5 },
      ],
      priceUsdBySymbol: prices,
      deployUsd: 1_000,
    });
    // Half the book today becomes a quarter of the book being aimed at;
    // showing 50% -> 50% beside a $500 buy would read as a no-op.
    expect(plan.orders[0]?.fromWeight).toBeCloseTo(0.25, 9);
    expect(plan.orders[0]?.toWeight).toBeCloseTo(0.5, 9);
  });

  test("still refuses to churn on drift when no capital is deployed", () => {
    // The guard must survive the fix: sub-tolerance drift with no new money
    // is still not worth a spread plus a transfer fee.
    const plan = planRebalance({
      target,
      holdings: [
        { symbol: "OPENAI", uiAmount: 0.502 },
        { symbol: "ANTHROPIC", uiAmount: 0.498 },
      ],
      priceUsdBySymbol: prices,
      deployUsd: 0,
      toleranceBps: 50,
      minTicketUsd: 0,
    });
    expect(plan.orders).toHaveLength(0);
    expect(plan.skipped.every((s) => s.reason === "within tolerance")).toBe(true);
  });

  test("a tiny top-up is still skipped as churn", () => {
    // Dollars are what the guard measures, so a trivial deposit does not
    // force a trade just because new money arrived.
    const plan = planRebalance({
      target,
      holdings: [
        { symbol: "OPENAI", uiAmount: 0.5 },
        { symbol: "ANTHROPIC", uiAmount: 0.5 },
      ],
      priceUsdBySymbol: prices,
      deployUsd: 2,
      toleranceBps: 50,
      minTicketUsd: 0,
    });
    expect(plan.orders).toHaveLength(0);
  });

  test("does nothing for an empty wallet with no capital to deploy", () => {
    const plan = planRebalance({ target, holdings: [], priceUsdBySymbol: prices });
    expect(plan.orders).toHaveLength(0);
    expect(plan.targetValueUsd).toBe(0);
  });
});
