import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIMITS,
  judgeLeg,
  slippageBpsFor,
  summarize,
  transferFeeCostUsd,
  type PlannedLeg,
} from "../src/execution.ts";
import { capWeights } from "../src/portfolio.ts";

describe("judgeLeg", () => {
  const deep = { liquidityUsd: 1_000_000 };

  test("accepts a leg inside both limits", () => {
    const verdict = judgeLeg({ symbol: "OPENAI", usd: 1_000, priceImpact: 0.006, ...deep });
    expect(verdict.kind).toBe("accept");
  });

  test("resizes a leg whose impact is too high", () => {
    // Measured: $10k of SPACEX came back at 6.7% impact.
    const verdict = judgeLeg({ symbol: "SPACEX", usd: 10_000, priceImpact: 0.067, ...deep });
    expect(verdict.kind).toBe("resize");
    if (verdict.kind !== "resize") throw new Error("unreachable");
    expect(verdict.usd).toBeLessThan(10_000);
    // sqrt(0.02 / 0.067) x 10000
    expect(verdict.usd).toBeCloseTo(10_000 * Math.sqrt(0.02 / 0.067), 6);
  });

  test("defers a leg no viable size can clear", () => {
    // Measured: $50k of NEURALINK came back at 56.8% impact.
    const verdict = judgeLeg(
      { symbol: "NEURALINK", usd: 50_000, priceImpact: 0.568, ...deep },
      { ...DEFAULT_LIMITS, minTicketUsd: 20_000 },
    );
    expect(verdict.kind).toBe("defer");
  });

  test("caps a leg at a share of quotable depth", () => {
    // KALSHI has under $100k of depth; a $50k leg is half the pool.
    const verdict = judgeLeg({
      symbol: "KALSHI",
      usd: 50_000,
      priceImpact: 0.01,
      liquidityUsd: 97_726,
    });
    expect(verdict.kind).toBe("resize");
    if (verdict.kind !== "resize") throw new Error("unreachable");
    expect(verdict.usd).toBeCloseTo(9_772.6, 1);
    expect(verdict.reason).toContain("depth");
  });

  test("the depth cap is checked before the impact estimate", () => {
    // A quote can report low impact at a size that still swallows the pool;
    // depth is the harder constraint and must win.
    const verdict = judgeLeg({ symbol: "KALSHI", usd: 50_000, priceImpact: 0.001, liquidityUsd: 97_726 });
    expect(verdict.kind).toBe("resize");
  });

  test("defers when the pool is too shallow for any allowed size", () => {
    const verdict = judgeLeg({ symbol: "THIN", usd: 1_000, priceImpact: 0.5, liquidityUsd: 40 });
    expect(verdict.kind).toBe("defer");
  });
});

describe("transferFeeCostUsd", () => {
  // The fee is assessed on the GROSS the pool sends, and the aggregator quotes
  // the NET, so recovering the fee means grossing up. A mainnet simulation
  // pinned the arithmetic: gross 488,641,136, fee 2,443,206, net 486,197,930.
  test("recovers the fee observed in the mainnet simulation", () => {
    const net = 486_197_930;
    const fee = transferFeeCostUsd(net, 50);
    expect(fee).toBeCloseTo(2_443_206, 0);
    expect(net + fee).toBeCloseTo(488_641_136, 0);
  });

  test("grosses up rather than multiplying the net", () => {
    // The naive net x rate would give exactly 5; the correct answer is larger.
    expect(transferFeeCostUsd(1_000, 50)).toBeCloseTo(5.0251256, 6);
    expect(transferFeeCostUsd(1_000, 50)).toBeGreaterThan(5);
  });

  test("roughly doubles once epoch 1039 lands", () => {
    expect(transferFeeCostUsd(1_000, 100)).toBeCloseTo(10.10101, 4);
  });

  test("is zero when no fee is configured", () => {
    expect(transferFeeCostUsd(1_000, 0)).toBe(0);
  });
});

describe("summarize", () => {
  const leg = (usd: number, impact: number, cost: number | null): PlannedLeg => ({
    order: { symbol: "X", side: "buy", usd, fromWeight: 0, toWeight: 1 },
    usd,
    priceImpact: impact,
    expectedOutUi: 1,
    effectivePriceUsd: usd,
    referencePriceUsd: usd,
    costVsReference: cost,
    transferFeeUsd: transferFeeCostUsd(usd, 50),
    note: null,
  });

  test("totals realized cost from measured fills", () => {
    const plan = summarize([leg(1_000, 0.005, 0.01), leg(1_000, 0.005, 0.02)], []);
    expect(plan.totalUsd).toBe(2_000);
    expect(plan.totalCostUsd).toBeCloseTo(30, 9);
    expect(plan.costFraction).toBeCloseTo(30 / 2_000, 9);
  });

  test("does not add the transfer fee on top of realized cost", () => {
    // The quote is already net of the fee. Counting it again would push the
    // total to 30 + fees; it must stay at the measured 30.
    const plan = summarize([leg(1_000, 0.005, 0.01), leg(1_000, 0.005, 0.02)], []);
    expect(plan.totalTransferFeeUsd).toBeGreaterThan(0);
    expect(plan.totalCostUsd).toBeCloseTo(30, 9);
  });

  test("falls back to price impact when cost could not be measured", () => {
    const plan = summarize([leg(1_000, 0.03, null)], []);
    expect(plan.totalCostUsd).toBeCloseTo(30, 9);
  });

  test("an empty plan costs nothing rather than dividing by zero", () => {
    const plan = summarize([], []);
    expect(plan.costFraction).toBe(0);
  });
});

describe("capWeights invariants", () => {
  test("holds across random allocations", () => {
    // Deterministic pseudo-random so a failure is reproducible.
    let seed = 42;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };

    for (let trial = 0; trial < 500; trial++) {
      const n = 2 + Math.floor(next() * 7);
      const weights = Array.from({ length: n }, (_, i) => ({
        symbol: `T${i}`,
        weight: next() ** 3 + 1e-6, // skewed, to produce dominant names
      }));
      // Only caps that are actually satisfiable.
      const cap = Math.max(1 / n, next());

      const out = capWeights(weights, cap);
      const total = out.reduce((s, w) => s + w.weight, 0);

      expect(total).toBeCloseTo(1, 9);
      for (const w of out) {
        expect(w.weight).toBeLessThanOrEqual(cap + 1e-9);
        expect(w.weight).toBeGreaterThan(0);
      }
      expect(out).toHaveLength(n);
    }
  });
});

describe("slippageBpsFor", () => {
  /**
   * A single global tolerance cannot work in this market. These pools carry
   * bid-ask spread floors of two to four percent and move within seconds of
   * a quote: a bundle built and simulated seven seconds apart landed two of
   * six legs at a flat 100 bps and six of six at 300. Setting one number
   * high enough for the worst pool also hands the deepest pool far more room
   * than it needs, so the tolerance follows the impact each leg measured.
   */
  test("a deep pool gets the floor and no more", () => {
    expect(slippageBpsFor(0.0005)).toBe(158);
    expect(slippageBpsFor(0)).toBe(150);
  });

  test("a thin pool gets room proportional to what it cost", () => {
    // NEURALINK measured 4.41% impact on a real quote.
    expect(slippageBpsFor(0.0441)).toBe(812);
    // FIGUREAI measured 3.06%.
    expect(slippageBpsFor(0.0306)).toBe(609);
  });

  test("a favourable route needs no extra room", () => {
    // Negative impact means the route beat the reference price.
    expect(slippageBpsFor(-0.02)).toBe(150);
  });

  test("nothing is written a blank cheque", () => {
    expect(slippageBpsFor(5)).toBe(1_000);
    expect(slippageBpsFor(Number.POSITIVE_INFINITY)).toBe(150);
    expect(slippageBpsFor(Number.NaN)).toBe(150);
  });

  test("the caller's tolerance is a floor, never a ceiling", () => {
    // A user asking for more room gets it; one asking for less still gets
    // enough for the pool, rather than a revert after they have signed.
    expect(slippageBpsFor(0.0441, { floorBps: 500 })).toBeGreaterThanOrEqual(500);
    expect(slippageBpsFor(0.0441, { floorBps: 10 })).toBeGreaterThan(600);
  });
});
