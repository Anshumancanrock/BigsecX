import { describe, expect, test } from "bun:test";
import {
  CURVE_POINTS,
  axisLabels,
  fallbackFrames,
  fmtChange,
  framesFromHistory,
  normalise,
  polygon,
  polyline,
  resample,
  seeded,
  stepOf,
  tick,
  yOf,
} from "../src/landing/phone-model.ts";
import { popDigits } from "../src/lib/digits.ts";

describe("popDigits", () => {
  test("only the characters that changed get new keys, staggered in order", () => {
    const first = popDigits(null, "$12,847", 0);
    expect(first.digits.every((d) => d.stagger !== null)).toBe(true);
    const next = popDigits(first.digits, "$12,851", first.nextKey);
    // "$12,8" is unchanged and keeps its keys; "5" and "1" are new.
    expect(next.digits.slice(0, 5).map((d) => d.key)).toEqual(first.digits.slice(0, 5).map((d) => d.key));
    expect(next.digits.slice(0, 5).every((d) => d.stagger === null)).toBe(true);
    expect(next.digits.slice(5).map((d) => d.stagger)).toEqual([0, 1]);
  });

  test("the stagger is capped so a long change does not trail", () => {
    const { digits } = popDigits(null, "123456789", 0);
    expect(Math.max(...digits.map((d) => d.stagger ?? 0))).toBe(4);
  });
});

describe("fmtChange", () => {
  test("writes a loss and a gain the way the reference does", () => {
    expect(fmtChange(-158.62, 12_900)).toBe("-$158.62 (-1.23%)");
    expect(fmtChange(2_536.55, 10_311)).toBe("+$2,536.55 (+24.6%)");
  });
});

describe("the chart geometry", () => {
  test("keeps 12px clear top and bottom", () => {
    expect(yOf(1)).toBe(12);
    expect(yOf(0)).toBe(215 - 12);
  });

  test("the first point sits one step off the left edge, the last at the gutter", () => {
    const points = Array.from({ length: CURVE_POINTS }, () => 0.5);
    const xs = polyline(points).split(" ").map((p) => Number(p.split(",")[0]));
    expect(xs[0]).toBeCloseTo(-stepOf(CURVE_POINTS), 9);
    expect(xs[xs.length - 1]).toBeCloseTo(390 - 64, 9);
    expect(polygon(points).startsWith(`${-stepOf(CURVE_POINTS)},215`)).toBe(true);
  });

  test("labels the axis at the reference's three heights", () => {
    const labels = axisLabels({ lo: 4_890, hi: 16_000 });
    expect(labels.map((l) => l.label)).toEqual(["$15,445", "$11,778", "$8,001"]);
    expect(labels[0]!.y).toBeCloseTo(21.55, 6);
  });
});

describe("tick", () => {
  test("moves the balance a hair and scrolls one point in", () => {
    const random = seeded("t");
    const points = Array.from({ length: CURVE_POINTS }, (_, i) => 0.3 + i * 0.005);
    const next = tick({ balance: 10_000, points, range: { lo: 8_000, hi: 12_000 } }, random);
    expect(Math.abs(next.balance / 10_000 - 1)).toBeLessThanOrEqual(3e-4);
    expect(next.points.length).toBe(CURVE_POINTS);
    expect(next.points[0]).toBe(points[1]);
    expect(next.points[next.points.length - 1]).toBeGreaterThanOrEqual(0.02);
    expect(next.points[next.points.length - 1]).toBeLessThanOrEqual(1);
  });
});

describe("frames", () => {
  const days = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 4, 1) + i * 86_400_000).toISOString().slice(0, 10));
  const table = { days, prices: { A: days.map((_, i) => 100 + i), B: days.map((_, i) => 50 + (i % 10)) } };

  test("come from the basket's real line, and share one balance", () => {
    const frames = framesFromHistory(table, [{ symbol: "A", weight: 0.5 }, { symbol: "B", weight: 0.5 }])!;
    expect(frames).not.toBeNull();
    const month = frames.get("1M")!;
    const max = frames.get("Max")!;
    expect(month.balance).toBe(max.balance);
    expect(max.base).toBeCloseTo(10_000, 6);
    expect(month.points.length).toBe(CURVE_POINTS);
    expect(month.base).toBeGreaterThan(max.base);
  });

  test("too little history is no frames, and the fallback always draws", () => {
    expect(framesFromHistory({ days: days.slice(0, 3), prices: {} }, [{ symbol: "A", weight: 1 }])).toBeNull();
    const fallback = fallbackFrames();
    expect(fallback.get("6M")!.points.length).toBe(CURVE_POINTS);
    // Seeded: the same line every visit.
    expect(fallbackFrames().get("1M")!.points).toEqual(fallback.get("1M")!.points);
  });
});

describe("helpers", () => {
  test("resample hits both ends exactly", () => {
    const out = resample([1, 2, 3], 5);
    expect(out).toEqual([1, 1.5, 2, 2.5, 3]);
  });

  test("normalise stays inside the drawable band", () => {
    expect(normalise(-5, { lo: 0, hi: 10 })).toBe(0.02);
    expect(normalise(50, { lo: 0, hi: 10 })).toBe(1);
  });
});
