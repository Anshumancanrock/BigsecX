import { describe, expect, test } from "bun:test";
import { averageHoldSeconds, symbolBooks, type TimedTrade } from "../src/trader-books.ts";

const prices = new Map([["OPENAI", 1_000], ["SPACEX", 120]]);
const DAY = 86_400;
const trade = (
  symbol: string,
  uiAmount: number,
  valueUsd: number | null,
  slot: number,
  blockTime: number | null = slot * 10,
): TimedTrade => ({ symbol, uiAmount, valueUsd, slot, blockTime });

describe("symbolBooks", () => {
  test("an open position keeps its cost and is not closed", () => {
    const [book] = symbolBooks([trade("OPENAI", 1, 1_000, 1), trade("OPENAI", 0.5, 480, 2)], prices);
    expect(book!.uiAmount).toBeCloseTo(1.5, 9);
    expect(book!.boughtUsd).toBe(1_480);
    expect(book!.netInvestedUsd).toBe(1_480);
    expect(book!.closed).toBe(false);
    expect(book!.complete).toBe(true);
    expect(book!.trades).toBe(2);
  });

  test("a sold-out position is closed, with what it made", () => {
    const [book] = symbolBooks([trade("OPENAI", 1, 1_000, 1), trade("OPENAI", -1, -1_150, 2)], prices);
    expect(book!.closed).toBe(true);
    expect(book!.uiAmount).toBe(0);
    expect(book!.soldUsd).toBe(1_150);
    expect(book!.netInvestedUsd).toBe(-150);
  });

  test("selling shares never seen bought marks the record incomplete", () => {
    const [book] = symbolBooks([trade("SPACEX", -2, -240, 1)], prices);
    expect(book!.complete).toBe(false);
    // Never held, so not a closed position either.
    expect(book!.closed).toBe(false);
  });

  test("an unbelievable cost is dropped and flagged", () => {
    const [book] = symbolBooks([trade("OPENAI", 0.0004, 92, 1)], prices);
    expect(book!.boughtUsd).toBe(0);
    expect(book!.complete).toBe(false);
  });

  test("each company keeps its own book", () => {
    const books = symbolBooks([trade("OPENAI", 1, 1_000, 1), trade("SPACEX", 1, 120, 2)], prices);
    expect(books.map((b) => b.symbol).sort()).toEqual(["OPENAI", "SPACEX"]);
  });
});

describe("averageHoldSeconds", () => {
  test("a round trip holds from the buy to the sale", () => {
    const held = averageHoldSeconds(
      [trade("OPENAI", 1, 1_000, 1, 0), trade("OPENAI", -1, -1_000, 2, 2 * DAY)],
      10 * DAY,
    );
    expect(held).toBe(2 * DAY);
  });

  test("an open position counts up to now", () => {
    expect(averageHoldSeconds([trade("OPENAI", 1, 1_000, 1, DAY)], 4 * DAY)).toBe(3 * DAY);
  });

  test("topping up does not start a new hold", () => {
    const held = averageHoldSeconds(
      [
        trade("OPENAI", 1, 1_000, 1, 0),
        trade("OPENAI", 1, 1_000, 2, DAY),
        trade("OPENAI", -2, -2_000, 3, 3 * DAY),
      ],
      9 * DAY,
    );
    expect(held).toBe(3 * DAY);
  });

  test("holds are averaged across companies", () => {
    const held = averageHoldSeconds(
      [
        trade("OPENAI", 1, 1_000, 1, 0),
        trade("OPENAI", -1, -1_000, 2, DAY),
        trade("SPACEX", 1, 120, 3, 0),
        trade("SPACEX", -1, -120, 4, 3 * DAY),
      ],
      9 * DAY,
    );
    expect(held).toBe(2 * DAY);
  });

  test("nothing to measure is null, not zero", () => {
    expect(averageHoldSeconds([], 100)).toBeNull();
    expect(averageHoldSeconds([trade("OPENAI", -1, -1_000, 1)], 100)).toBeNull();
    // A buy with no known time cannot be timed.
    expect(averageHoldSeconds([trade("OPENAI", 1, 1_000, 1, null)], 100)).toBeNull();
  });
});

describe("trades in one slot", () => {
  const pair = [trade("OPENAI", 1, 1_000, 5, 50), trade("OPENAI", -1, -1_000, 5, 50)];

  test("give the same book in either order", () => {
    const one = symbolBooks(pair, prices);
    const other = symbolBooks([...pair].reverse(), prices);
    expect(one).toEqual(other);
    // Net nothing: never held, so not a closed position.
    expect(one[0]!.closed).toBe(false);
    expect(one[0]!.trades).toBe(2);
  });

  test("give the same hold time in either order", () => {
    const opening = trade("OPENAI", 2, 2_000, 1, 0);
    expect(averageHoldSeconds([opening, ...pair], 100)).toBe(averageHoldSeconds([opening, ...[...pair].reverse()], 100));
  });
});
