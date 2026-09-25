import { describe, expect, test } from "bun:test";
import { planRebalance } from "../src/portfolio.ts";
import {
  CopyLimitsInvalid,
  DEFAULT_COPY_LIMITS,
  previewCopy,
  stopLossTriggered,
  validateCopyLimits,
  type CopyLimits,
} from "../src/copy.ts";

const LEADER = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const limits = (over: Partial<CopyLimits> = {}): CopyLimits => ({
  capitalUsd: 1_000,
  ...DEFAULT_COPY_LIMITS,
  ...over,
});
const leaderWeights = [
  { symbol: "OPENAI", weight: 0.5 },
  { symbol: "ANTHROPIC", weight: 0.3 },
  { symbol: "SPACEX", weight: 0.2 },
];

describe("previewCopy", () => {
  test("copies weights, so the size of the leader's book is irrelevant", () => {
    // A leader spending $700 of $100,000 moved 0.7% of their portfolio. A
    // follower copying the dollar amount would move 70% of theirs.
    const preview = previewCopy({ leader: LEADER, leaderWeights, limits: limits() });
    expect(preview.deployUsd).toBe(1_000);
    expect(preview.positions.find((p) => p.symbol === "OPENAI")?.usd).toBeCloseTo(500, 6);
    expect(preview.positions.find((p) => p.symbol === "SPACEX")?.usd).toBeCloseTo(200, 6);
  });

  test("a copy ratio below one keeps the rest in stablecoin", () => {
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights,
      limits: limits({ copyRatio: 0.25 }),
    });
    expect(preview.deployUsd).toBe(250);
    expect(preview.reserveUsd).toBe(750);
    // Same exposure, smaller: the allocation is unchanged.
    expect(preview.targetWeights.find((w) => w.symbol === "OPENAI")?.weight).toBeCloseTo(0.5, 9);
    expect(preview.notes.join(" ")).toContain("stablecoin");
  });

  test("an excluded symbol is redistributed, not left as cash", () => {
    // Refusing one name must not silently put the follower partly in cash.
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights,
      limits: limits({ excludeSymbols: ["SPACEX"] }),
    });
    expect(preview.positions.map((p) => p.symbol).sort()).toEqual(["ANTHROPIC", "OPENAI"]);
    expect(preview.positions.reduce((s, p) => s + p.usd, 0)).toBeCloseTo(1_000, 6);
    expect(preview.excluded[0]).toEqual({
      symbol: "SPACEX",
      weight: 0.2,
      reason: "excluded by the follower",
    });
  });

  test("a paused mint is dropped and named", () => {
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights,
      limits: limits(),
      pausedSymbols: ["OPENAI"],
    });
    expect(preview.positions.some((p) => p.symbol === "OPENAI")).toBe(false);
    expect(preview.excluded[0]?.reason).toContain("halted");
  });

  test("copies faithfully by default, with no cap imposed", () => {
    // A default cap would give the follower a different allocation than the
    // leader's.
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights: [
        { symbol: "OPENAI", weight: 0.9 },
        { symbol: "ANTHROPIC", weight: 0.1 },
      ],
      limits: limits(),
    });
    expect(preview.targetWeights.find((w) => w.symbol === "OPENAI")?.weight).toBeCloseTo(0.9, 9);
    expect(preview.notes.join(" ")).not.toContain("position cap");
  });

  test("says where a chosen cap changed the allocation", () => {
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights: [
        { symbol: "OPENAI", weight: 0.9 },
        { symbol: "ANTHROPIC", weight: 0.05 },
        { symbol: "SPACEX", weight: 0.05 },
      ],
      limits: limits({ maxPositionWeight: 0.4 }),
    });
    expect(preview.notes.join(" ")).toContain("OPENAI");
    expect(preview.notes.join(" ")).toContain("differs from the leader");
  });

  test("the position cap is applied to what survives", () => {
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights: [
        { symbol: "OPENAI", weight: 0.9 },
        { symbol: "ANTHROPIC", weight: 0.05 },
        { symbol: "SPACEX", weight: 0.05 },
      ],
      limits: limits({ maxPositionWeight: 0.4 }),
    });
    for (const w of preview.targetWeights) expect(w.weight).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(preview.targetWeights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 9);
  });

  test("an unsatisfiable cap is widened and explained, not failed", () => {
    // Two positions cannot both sit under 40%; the preview names the tightest
    // possible cap instead of failing.
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights: [
        { symbol: "OPENAI", weight: 0.5 },
        { symbol: "ANTHROPIC", weight: 0.5 },
      ],
      limits: limits({ maxPositionWeight: 0.4 }),
    });
    expect(preview.targetWeights.map((w) => w.weight)).toEqual([0.5, 0.5]);
    expect(preview.notes.join(" ")).toContain("tightest possible");
  });

  test("excluding everything deploys nothing rather than throwing", () => {
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights,
      limits: limits({ excludeSymbols: ["OPENAI", "ANTHROPIC", "SPACEX"] }),
    });
    expect(preview.positions).toHaveLength(0);
    expect(preview.deployUsd).toBe(0);
    expect(preview.reserveUsd).toBe(1_000);
    expect(preview.notes.join(" ")).toContain("Nothing");
  });

  test("a leader holding nothing yields nothing", () => {
    const preview = previewCopy({ leader: LEADER, leaderWeights: [], limits: limits() });
    expect(preview.positions).toHaveLength(0);
  });

  test("symbols are matched case-insensitively", () => {
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights: [
        { symbol: "openai", weight: 1 },
        { symbol: "ANTHROPIC", weight: 1 },
      ],
      limits: limits({ excludeSymbols: ["OpenAI"] }),
    });
    expect(preview.positions.map((p) => p.symbol)).toEqual(["ANTHROPIC"]);
  });
});

describe("validateCopyLimits", () => {
  const rejects = (over: Partial<CopyLimits>, fragment: string) => {
    try {
      validateCopyLimits(limits(over));
    } catch (error) {
      expect((error as CopyLimitsInvalid).message).toContain(fragment);
      return;
    }
    throw new Error(`expected rejection containing ${fragment}`);
  };

  test("rejects impossible capital", () => {
    rejects({ capitalUsd: 0 }, "capitalUsd");
    rejects({ capitalUsd: Number.NaN }, "capitalUsd");
    rejects({ capitalUsd: 1e12 }, "at most");
  });

  test("rejects an out-of-range copy ratio", () => {
    rejects({ copyRatio: 0 }, "copyRatio");
    rejects({ copyRatio: 1.5 }, "copyRatio");
  });

  test("rejects an out-of-range position cap and slippage", () => {
    rejects({ maxPositionWeight: 0 }, "maxPositionWeight");
    rejects({ maxSlippageBps: 0 }, "maxSlippageBps");
    rejects({ maxSlippageBps: 99_999 }, "maxSlippageBps");
  });

  test("rejects an unknown excluded symbol", () => {
    rejects({ excludeSymbols: ["NVDA"] }, "unknown excluded symbol");
  });

  test("rejects a stop loss outside 0..1", () => {
    rejects({ stopLossFraction: 0 }, "stopLossFraction");
    rejects({ stopLossFraction: 1 }, "stopLossFraction");
  });

  test("accepts sane limits", () => {
    expect(() => validateCopyLimits(limits({ stopLossFraction: 0.15 }))).not.toThrow();
  });
});

describe("stopLossTriggered", () => {
  test("measures drawdown from the peak, not from entry", () => {
    // Doubled then halved: flat on entry, but down 50% from the peak.
    const result = stopLossTriggered({
      peakValueUsd: 2_000,
      currentValueUsd: 1_000,
      stopLossFraction: 0.15,
    });
    expect(result.drawdownFraction).toBeCloseTo(0.5, 9);
    expect(result.triggered).toBe(true);
  });

  test("does not fire inside the limit", () => {
    const result = stopLossTriggered({
      peakValueUsd: 1_000,
      currentValueUsd: 950,
      stopLossFraction: 0.15,
    });
    expect(result.triggered).toBe(false);
  });

  test("reports drawdown even with no limit set", () => {
    const result = stopLossTriggered({
      peakValueUsd: 1_000,
      currentValueUsd: 500,
      stopLossFraction: undefined,
    });
    expect(result.triggered).toBe(false);
    expect(result.drawdownFraction).toBeCloseTo(0.5, 9);
  });

  test("a new high is zero drawdown, not negative", () => {
    const result = stopLossTriggered({
      peakValueUsd: 1_000,
      currentValueUsd: 1_500,
      stopLossFraction: 0.15,
    });
    expect(result.drawdownFraction).toBe(0);
  });
});

describe("a copy preview is exactly what a rebalance will do", () => {
  /**
   * Deploying capital with no existing holdings yields one buy per target
   * weight, sized weight x capital, so the approved preview is exactly what the
   * builder emits. Passing the follower's unrelated holdings breaks this.
   */
  const prices = new Map([
    ["OPENAI", 100],
    ["ANTHROPIC", 100],
    ["SPACEX", 100],
    ["KALSHI", 100],
  ]);

  test("every preview position becomes an identically sized buy", () => {
    const preview = previewCopy({ leader: LEADER, leaderWeights, limits: limits() });
    const plan = planRebalance({
      target: preview.targetWeights,
      holdings: [],
      priceUsdBySymbol: prices,
      deployUsd: preview.deployUsd,
    });

    expect(plan.orders).toHaveLength(preview.positions.length);
    for (const position of preview.positions) {
      const order = plan.orders.find((o) => o.symbol === position.symbol);
      expect(order?.side).toBe("buy");
      expect(order?.usd).toBeCloseTo(position.usd, 9);
    }
  });

  test("holds at a reduced copy ratio too", () => {
    const preview = previewCopy({
      leader: LEADER,
      leaderWeights,
      limits: limits({ copyRatio: 0.3 }),
    });
    const plan = planRebalance({
      target: preview.targetWeights,
      holdings: [],
      priceUsdBySymbol: prices,
      deployUsd: preview.deployUsd,
    });
    expect(plan.orders.reduce((s, o) => s + o.usd, 0)).toBeCloseTo(300, 6);
    expect(plan.orders.every((o) => o.side === "buy")).toBe(true);
  });

  test("unrelated holdings would break it, which is why none are passed", () => {
    // With the follower's other position included, the same target sells it
    // and plans six times the notional.
    const preview = previewCopy({ leader: LEADER, leaderWeights, limits: limits() });
    const wrong = planRebalance({
      target: preview.targetWeights,
      holdings: [{ symbol: "KALSHI", uiAmount: 50 }], // $5,000
      priceUsdBySymbol: prices,
      deployUsd: preview.deployUsd,
    });
    expect(wrong.orders.some((o) => o.side === "sell")).toBe(true);
    expect(wrong.targetValueUsd).toBe(6_000);
  });
});
