import { describe, expect, test } from "bun:test";
import type { Market } from "../src/lib/api.ts";
import { withLivePrices } from "../src/lib/live.ts";

const market = (prices: Record<string, number | null>): Market =>
  ({
    takenAt: "2026-09-25T15:00:00.000Z",
    tokens: Object.entries(prices).map(([symbol, marketUsd]) => ({ symbol, marketUsd })),
  }) as unknown as Market;

const table: {
  asOf: string;
  days: string[];
  prices: Record<string, readonly (number | null)[]>;
} = {
  asOf: "2026-09-25T14:55:00.000Z",
  days: ["2026-09-24", "2026-09-25"],
  prices: { OPENAI: [1300, 1310], SPACEX: [115, 116], KALSHI: [null, null] },
};

describe("withLivePrices", () => {
  test("puts the live price on each series' newest point, and nowhere else", () => {
    const live = withLivePrices(table, market({ OPENAI: 1349.25, SPACEX: 116 }))!;
    expect(live.prices.OPENAI).toEqual([1300, 1349.25]);
    expect(live.prices.SPACEX).toBe(table.prices.SPACEX);
    expect(live.days).toBe(table.days);
    expect(live.asOf).toBe(table.asOf);
  });

  test("leaves the table itself untouched", () => {
    withLivePrices(table, market({ OPENAI: 1349.25 }));
    expect(table.prices.OPENAI).toEqual([1300, 1310]);
  });

  test("returns the very same table when no price has moved, so nothing redraws", () => {
    expect(withLivePrices(table, market({ OPENAI: 1310, SPACEX: 116 }))).toBe(table);
  });

  test("ignores a company with no live price, and one the table does not have", () => {
    expect(withLivePrices(table, market({ OPENAI: null, ANDURIL: 160 }))).toBe(table);
  });

  test("fills the end of a series that had no price at all", () => {
    expect(withLivePrices(table, market({ KALSHI: 880 }))!.prices.KALSHI).toEqual([null, 880]);
  });

  test("passes through when either side is missing", () => {
    expect(withLivePrices(null, market({ OPENAI: 1 }))).toBeNull();
    expect(withLivePrices(table, null)).toBe(table);
  });
});
