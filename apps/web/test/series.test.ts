import { describe, expect, test } from "bun:test";
import {
  axisUsd,
  basketSeries,
  firstValue,
  forwardFill,
  holdingsSeries,
  niceTicks,
  sampleIndices,
  smoothPath,
  xLabels,
} from "../src/lib/series.ts";

const table = {
  days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
  prices: {
    A: [100, 110, null, 120],
    B: [null, 50, 55, 60],
  },
};

describe("forwardFill", () => {
  test("carries values over gaps and leaves leading gaps empty", () => {
    expect(forwardFill([null, 1, null, 3])).toEqual([null, 1, 1, 3]);
  });
});

describe("basketSeries", () => {
  test("values a starting amount through the basket's prices", () => {
    // $1,000 all in A at 100 is 10 units: 1,100 then 1,100 (gap filled) then 1,200.
    expect(basketSeries(table, [{ symbol: "A", weight: 1 }], 1_000)).toEqual([1_000, 1_100, 1_100, 1_200]);
  });

  test("a company with no price on the start day is left out, not assumed", () => {
    // B had no price on day 0, so the whole $1,000 goes to A.
    expect(basketSeries(table, [{ symbol: "A", weight: 0.5 }, { symbol: "B", weight: 0.5 }], 1_000)[3]).toBe(1_200);
  });

  test("starting later includes what was trading by then", () => {
    const series = basketSeries(table, [{ symbol: "A", weight: 0.5 }, { symbol: "B", weight: 0.5 }], 1_000, 1);
    expect(series[0]).toBeNull();
    expect(series[1]).toBeCloseTo(1_000, 9);
    // A: 500/110 units at 120, B: 500/50 units at 60.
    expect(series[3]).toBeCloseTo((500 / 110) * 120 + 10 * 60, 9);
  });
});

describe("holdingsSeries", () => {
  test("is null until every holding has a price", () => {
    expect(holdingsSeries(table, { A: 2, B: 1 })).toEqual([null, 270, 275, 300]);
  });

  test("no holdings is no line", () => {
    expect(firstValue(holdingsSeries(table, {}))).toBe(-1);
  });
});

describe("niceTicks", () => {
  test("starts at zero and ends on a round number above the max", () => {
    expect(niceTicks(36_000)).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
    expect(niceTicks(1_340)).toEqual([0, 500, 1_000, 1_500]);
  });

  test("survives a flat or empty series", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  test("starts above zero only for a narrow band far from it", () => {
    const ticks = niceTicks(470_000, 4, 400_000);
    expect(ticks[0]).toBeGreaterThan(0);
    expect(ticks[0]).toBeLessThanOrEqual(400_000);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(470_000);
    // A series that swings widely stays zero-based.
    expect(niceTicks(3_000, 4, 900)[0]).toBe(0);
  });
});

describe("axisUsd", () => {
  test("reads like the reference axis", () => {
    expect(axisUsd(40_000)).toBe("$40K");
    expect(axisUsd(1_500)).toBe("$1.5K");
    expect(axisUsd(950)).toBe("$950");
    expect(axisUsd(2.3)).toBe("$2.30");
    expect(axisUsd(0)).toBe("$0");
  });
});

describe("smoothPath", () => {
  test("never overshoots a peak", () => {
    const d = smoothPath([
      { x: 0, y: 50 },
      { x: 10, y: 10 },
      { x: 20, y: 50 },
    ]);
    // Every y in the path's control points stays within the data's range.
    // Numbers alternate x, y through M and every C segment.
    const numbers = [...d.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
    const ys = numbers.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...ys)).toBeLessThanOrEqual(50);
  });

  test("handles one point and none", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([{ x: 1, y: 2 }])).toBe("M1,2");
  });
});

describe("xLabels", () => {
  test("names months for a long range", () => {
    const days = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 4, 25) + i * 86_400_000).toISOString().slice(0, 10));
    expect(xLabels(days).map((l) => l.label)).toEqual(["June", "July", "Aug", "Sept"]);
  });

  test("uses dates for a short range", () => {
    const days = ["2026-09-01", "2026-09-02", "2026-09-03"];
    expect(xLabels(days).map((l) => l.label)).toEqual(["1 Sept", "2 Sept", "3 Sept"]);
  });
});

describe("sampleIndices", () => {
  test("keeps a short series whole", () => {
    expect(sampleIndices(5, 52)).toEqual([0, 1, 2, 3, 4]);
  });

  test("thins a long one and always keeps both ends", () => {
    const kept = sampleIndices(300, 50);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(299);
    expect(kept.length).toBeLessThanOrEqual(52);
  });
});
