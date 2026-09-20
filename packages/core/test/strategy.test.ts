import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GUARDRAILS,
  StrategyInvalid,
  buildStrategy,
  combinedExposure,
  driftExceeded,
  rebalanceIntervalMs,
  sectorExposure,
} from "../src/strategy.ts";

const NOW = new Date("2026-09-20T00:00:00Z");
const build = (draft: Parameters<typeof buildStrategy>[0], published = false) =>
  buildStrategy(draft, { id: "s1", now: NOW, published });

const problemsOf = (fn: () => unknown): readonly string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof StrategyInvalid) return error.problems;
    throw error;
  }
  throw new Error("expected StrategyInvalid");
};

describe("buildStrategy", () => {
  test("normalises arbitrary units into weights that sum to one", () => {
    // An author should be able to type percentages, dollars or scores.
    const strategy = build({
      name: "Private AI",
      constituents: [
        { symbol: "OPENAI", weight: 35 },
        { symbol: "ANTHROPIC", weight: 30 },
        { symbol: "ANDURIL", weight: 20 },
        { symbol: "FIGUREAI", weight: 15 },
      ],
    });
    expect(strategy.weights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 12);
    expect(strategy.weights.find((w) => w.symbol === "OPENAI")?.weight).toBeCloseTo(0.35, 12);
  });

  test("uppercases symbols so casing is not a source of duplicates", () => {
    const strategy = build({
      name: "x",
      constituents: [
        { symbol: "openai", weight: 1 },
        { symbol: "anthropic", weight: 1 },
      ],
    });
    expect(strategy.weights.map((w) => w.symbol).sort()).toEqual(["ANTHROPIC", "OPENAI"]);
  });

  test("caps a dominant position rather than rejecting it", () => {
    const strategy = build({
      name: "x",
      constituents: [
        { symbol: "OPENAI", weight: 90 },
        { symbol: "ANTHROPIC", weight: 5 },
        { symbol: "SPACEX", weight: 5 },
      ],
      guardrails: { maxWeight: 0.4, minWeight: 0.01 },
    });
    for (const w of strategy.weights) expect(w.weight).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(strategy.weights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 12);
  });

  test("rejects a position under the floor instead of quietly raising it", () => {
    // Raising it would change the allocation the author asked for.
    const problems = problemsOf(() =>
      build({
        name: "x",
        constituents: [
          { symbol: "OPENAI", weight: 97 },
          { symbol: "ANTHROPIC", weight: 2 },
          { symbol: "SPACEX", weight: 1 },
        ],
        guardrails: { maxWeight: 0.9, minWeight: 0.1 },
      }),
    );
    expect(problems.join(" ")).toContain("floor");
  });

  test("reports every problem at once", () => {
    // One per round trip sends the author back repeatedly.
    const problems = problemsOf(() =>
      build({ name: "", constituents: [{ symbol: "NOPE", weight: -1 }] }),
    );
    expect(problems.length).toBeGreaterThan(2);
    expect(problems.some((p) => p.includes("name"))).toBe(true);
    expect(problems.some((p) => p.includes("unknown symbol"))).toBe(true);
    expect(problems.some((p) => p.includes("at least"))).toBe(true);
  });

  test("rejects guardrails no basket could satisfy", () => {
    // Three positions cannot sum to 100% under a 25% cap.
    expect(
      problemsOf(() =>
        build({
          name: "x",
          constituents: [
            { symbol: "OPENAI", weight: 1 },
            { symbol: "ANTHROPIC", weight: 1 },
            { symbol: "SPACEX", weight: 1 },
          ],
          guardrails: { maxWeight: 0.25, minWeight: 0.01 },
        }),
      ).join(" "),
    ).toContain("cannot sum to 100%");

    // Nor above a 50% floor.
    expect(
      problemsOf(() =>
        build({
          name: "x",
          constituents: [
            { symbol: "OPENAI", weight: 1 },
            { symbol: "ANTHROPIC", weight: 1 },
            { symbol: "SPACEX", weight: 1 },
          ],
          guardrails: { maxWeight: 0.9, minWeight: 0.5 },
        }),
      ).join(" "),
    ).toContain("cannot sum to 100%");
  });

  test("rejects a single-name basket", () => {
    expect(
      problemsOf(() => build({ name: "x", constituents: [{ symbol: "OPENAI", weight: 1 }] })).join(" "),
    ).toContain("at least 2");
  });

  test("rejects duplicates", () => {
    expect(
      problemsOf(() =>
        build({
          name: "x",
          constituents: [
            { symbol: "OPENAI", weight: 1 },
            { symbol: "openai", weight: 1 },
          ],
        }),
      ).join(" "),
    ).toContain("duplicate");
  });

  test("enforces a sector ceiling", () => {
    // SpaceX and Anduril are both defence; together they breach a 50% cap.
    expect(
      problemsOf(() =>
        build({
          name: "x",
          constituents: [
            { symbol: "SPACEX", weight: 40 },
            { symbol: "ANDURIL", weight: 40 },
            { symbol: "KALSHI", weight: 20 },
          ],
          guardrails: { maxWeight: 0.5, minWeight: 0.01, maxSectorWeight: 0.5 },
        }),
      ).join(" "),
    ).toContain("sector cap");
  });

  test("a two-name basket is allowed by default", () => {
    // Prediction Markets is Kalshi and Polymarket at half each. A default cap
    // of 40% would reject it as impossible.
    const strategy = build({
      name: "Prediction Markets",
      constituents: [
        { symbol: "KALSHI", weight: 1 },
        { symbol: "POLYMARKET", weight: 1 },
      ],
    });
    expect(strategy.weights.map((w) => w.weight)).toEqual([0.5, 0.5]);
  });

  test("keeps the allocation the author asked for", () => {
    // Regression. A default cap silently turned a 60/40 pair into 50/50 --
    // the same silent mutation the minimum-weight floor exists to refuse.
    const strategy = build({
      name: "Humanoid Revolution",
      creator: "WALLET1",
      constituents: [
        { symbol: "FIGUREAI", weight: 60 },
        { symbol: "NEURALINK", weight: 40 },
      ],
    });
    expect(strategy.weights.find((w) => w.symbol === "FIGUREAI")?.weight).toBeCloseTo(0.6, 12);
    expect(strategy.weights.find((w) => w.symbol === "NEURALINK")?.weight).toBeCloseTo(0.4, 12);
  });

  test("a lopsided allocation survives when no cap is set", () => {
    const strategy = build({
      name: "x",
      constituents: [
        { symbol: "OPENAI", weight: 90 },
        { symbol: "ANTHROPIC", weight: 10 },
      ],
    });
    expect(strategy.weights.find((w) => w.symbol === "OPENAI")?.weight).toBeCloseTo(0.9, 12);
  });

  test("an explicit cap is enforced, never widened", () => {
    // The author asked for 25%; three names cannot reach 100% under it, and
    // silently raising the cap would ship an allocation they did not choose.
    expect(
      problemsOf(() =>
        build({
          name: "x",
          constituents: [
            { symbol: "OPENAI", weight: 1 },
            { symbol: "ANTHROPIC", weight: 1 },
            { symbol: "SPACEX", weight: 1 },
          ],
          guardrails: { maxWeight: 0.25 },
        }),
      ).join(" "),
    ).toContain("cannot sum to 100%");
  });

  test("an authored strategy is a user strategy; an unauthored one is an index", () => {
    const two = [
      { symbol: "OPENAI", weight: 1 },
      { symbol: "ANTHROPIC", weight: 1 },
    ];
    expect(build({ name: "x", constituents: two }).kind).toBe("index");
    expect(build({ name: "x", constituents: two, creator: "wallet" }).kind).toBe("user");
  });

  test("defaults to manual rebalancing and unpublished", () => {
    const strategy = build({
      name: "x",
      constituents: [
        { symbol: "OPENAI", weight: 1 },
        { symbol: "ANTHROPIC", weight: 1 },
      ],
    });
    expect(strategy.rebalance).toBe("manual");
    expect(strategy.published).toBe(false);
    // Defaults constrain nothing about the allocation.
    expect(strategy.guardrails).toEqual(DEFAULT_GUARDRAILS);
  });
});

describe("sectorExposure", () => {
  test("a token in two sectors counts in both", () => {
    // SpaceX is space and defence, so a 100% SpaceX basket is 100% of each.
    const exposure = sectorExposure([{ symbol: "SPACEX", weight: 1 }]);
    expect(exposure.get("space")).toBeCloseTo(1, 12);
    expect(exposure.get("defense")).toBeCloseTo(1, 12);
  });
});

describe("driftExceeded", () => {
  const target = [
    { symbol: "OPENAI", weight: 0.5 },
    { symbol: "ANTHROPIC", weight: 0.5 },
  ];

  test("ignores drift inside the threshold", () => {
    const result = driftExceeded(
      [
        { symbol: "OPENAI", weight: 0.51 },
        { symbol: "ANTHROPIC", weight: 0.49 },
      ],
      target,
      300,
    );
    expect(result.exceeded).toBe(false);
    expect(result.worst?.driftBps).toBeCloseTo(100, 6);
  });

  test("fires once drift passes it", () => {
    const result = driftExceeded(
      [
        { symbol: "OPENAI", weight: 0.56 },
        { symbol: "ANTHROPIC", weight: 0.44 },
      ],
      target,
      300,
    );
    expect(result.exceeded).toBe(true);
    expect(result.worst?.driftBps).toBeCloseTo(600, 6);
  });

  test("a position dropped entirely is full drift", () => {
    const result = driftExceeded([{ symbol: "OPENAI", weight: 1 }], target, 300);
    expect(result.exceeded).toBe(true);
    expect(result.worst?.driftBps).toBeCloseTo(5_000, 6);
  });
});

describe("rebalanceIntervalMs", () => {
  test("manual has no schedule", () => {
    expect(rebalanceIntervalMs("manual")).toBeNull();
  });
  test("the rest are ordered", () => {
    const daily = rebalanceIntervalMs("daily") ?? 0;
    const weekly = rebalanceIntervalMs("weekly") ?? 0;
    const monthly = rebalanceIntervalMs("monthly") ?? 0;
    expect(daily).toBeLessThan(weekly);
    expect(weekly).toBeLessThan(monthly);
  });
});

describe("combinedExposure", () => {
  test("reveals concentration hidden across several baskets", () => {
    // Two baskets, half the capital each, both heavy in OPENAI. The user
    // believes they are diversified and is 60% in one name.
    const combined = combinedExposure([
      {
        shareOfCapital: 0.5,
        weights: [
          { symbol: "OPENAI", weight: 0.6 },
          { symbol: "ANTHROPIC", weight: 0.4 },
        ],
      },
      {
        shareOfCapital: 0.5,
        weights: [
          { symbol: "OPENAI", weight: 0.6 },
          { symbol: "SPACEX", weight: 0.4 },
        ],
      },
    ]);
    expect(combined[0]).toEqual({ symbol: "OPENAI", weight: 0.6 });
    expect(combined.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 12);
  });

  test("returns nothing for no holdings", () => {
    expect(combinedExposure([])).toEqual([]);
  });
});
