import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, judgeLeg, summarize, transferFeeCostUsd, type PlannedLeg } from "../src/execution.ts";
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
  test("prices the live 50 bps fee", () => {
    expect(transferFeeCostUsd(1_000, 50)).toBe(5);
  });

  test("doubles once epoch 1039 lands", () => {
    expect(transferFeeCostUsd(1_000, 100)).toBe(10);
  });
});

describe("summarize", () => {
  const leg = (usd: number, impact: number, fee: number): PlannedLeg => ({
    order: { symbol: "X", side: "buy", usd, fromWeight: 0, toWeight: 1 },
    usd,
    priceImpact: impact,
    transferFeeUsd: fee,
    note: null,
  });

  test("totals impact and fee into an all-in cost", () => {
    const plan = summarize([leg(1_000, 0.01, 5), leg(1_000, 0.02, 5)], []);
    expect(plan.totalUsd).toBe(2_000);
    expect(plan.totalImpactUsd).toBeCloseTo(30, 9);
    expect(plan.totalTransferFeeUsd).toBe(10);
    expect(plan.costFraction).toBeCloseTo(40 / 2_000, 9);
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
