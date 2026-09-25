import { describe, expect, test } from "bun:test";
import { buildLeaderboard, computeTraderPnl, type TradeRecord } from "../src/trader-pnl.ts";

const prices = new Map([["OPENAI", 1_100], ["SPACEX", 120]]);
const trade = (
  symbol: string,
  uiAmount: number,
  valueUsd: number | null,
  slot: number,
): TradeRecord => ({ owner: "w", symbol, uiAmount, valueUsd, slot });

describe("computeTraderPnl", () => {
  test("an open position marks to market against its cost", () => {
    const pnl = computeTraderPnl("w", [trade("OPENAI", 1, 1_000, 10)], prices);
    expect(pnl.netInvestedUsd).toBe(1_000);
    expect(pnl.markValueUsd).toBe(1_100);
    expect(pnl.pnlUsd).toBeCloseTo(100, 9);
    expect(pnl.returnFraction).toBeCloseTo(0.1, 9);
    expect(pnl.coverageComplete).toBe(true);
  });

  test("return is measured against peak capital, not the closing balance", () => {
    // Bought $1,500, sold for $1,100: a 26.7% loss on the money committed.
    // Dividing by the closing netInvested of $400 would report -100%.
    const pnl = computeTraderPnl(
      "w",
      [trade("OPENAI", 1, 1_500, 10), trade("OPENAI", -1, -1_100, 20)],
      prices,
    );
    expect(pnl.peakInvestedUsd).toBe(1_500);
    expect(pnl.netInvestedUsd).toBe(400);
    expect(pnl.returnFraction).toBeCloseTo(-400 / 1_500, 9);
  });

  test("a closed round trip books the realised profit", () => {
    const pnl = computeTraderPnl(
      "w",
      [trade("OPENAI", 1, 1_000, 10), trade("OPENAI", -1, -1_200, 20)],
      prices,
    );
    expect(pnl.positions).toHaveLength(0);
    expect(pnl.markValueUsd).toBe(0);
    expect(pnl.netInvestedUsd).toBe(-200);
    expect(pnl.pnlUsd).toBeCloseTo(200, 9);
  });

  test("a loss is reported as a loss", () => {
    const pnl = computeTraderPnl(
      "w",
      [trade("OPENAI", 1, 1_500, 10), trade("OPENAI", -1, -1_100, 20)],
      prices,
    );
    expect(pnl.pnlUsd).toBeCloseTo(-400, 9);
    expect(pnl.returnFraction).toBeCloseTo(-400 / 1_500, 9);
  });

  test("mixes an open and a closed position correctly", () => {
    const pnl = computeTraderPnl(
      "w",
      [
        trade("OPENAI", 1, 1_000, 10),
        trade("OPENAI", -1, -1_200, 20),
        trade("SPACEX", 10, 1_000, 30),
      ],
      prices,
    );
    expect(pnl.pnlUsd).toBeCloseTo(400, 9);
  });

  test("flags a wallet that sold a bag it held before indexing began", () => {
    // Only a sell is observed; the buy predates indexing, so this looks like
    // free money and must not be ranked.
    const pnl = computeTraderPnl("w", [trade("OPENAI", -1, -1_200, 10)], prices);
    expect(pnl.coverageComplete).toBe(false);
    expect(pnl.positions).toEqual([{ symbol: "OPENAI", uiAmount: -1 }]);
    // Nothing was ever committed, so no return is claimed.
    expect(pnl.returnFraction).toBeNull();
  });

  test("order matters for the coverage check", () => {
    const covered = computeTraderPnl(
      "w",
      [trade("OPENAI", 1, 1_000, 10), trade("OPENAI", -1, -1_100, 20)],
      prices,
    );
    const uncovered = computeTraderPnl(
      "w",
      [trade("OPENAI", -1, -1_100, 10), trade("OPENAI", 1, 1_000, 20)],
      prices,
    );
    expect(covered.coverageComplete).toBe(true);
    expect(uncovered.coverageComplete).toBe(false);
  });

  test("sorts trades by slot regardless of input order", () => {
    const shuffled = computeTraderPnl(
      "w",
      [trade("OPENAI", -1, -1_100, 20), trade("OPENAI", 1, 1_000, 10)],
      prices,
    );
    expect(shuffled.coverageComplete).toBe(true);
  });

  test("ignores unpriced trades in the cash figures but still tracks shares", () => {
    const pnl = computeTraderPnl("w", [trade("OPENAI", 1, null, 10)], prices);
    expect(pnl.netInvestedUsd).toBe(0);
    expect(pnl.volumeUsd).toBe(0);
    expect(pnl.positions).toEqual([{ symbol: "OPENAI", uiAmount: 1 }]);
  });

  test("treats a dust residue as a closed position", () => {
    const pnl = computeTraderPnl(
      "w",
      [trade("OPENAI", 1, 1_000, 10), trade("OPENAI", -0.9999999999, -1_000, 20)],
      prices,
    );
    expect(pnl.positions).toHaveLength(0);
  });
});

describe("buildLeaderboard", () => {
  const priced = new Map([["OPENAI", 1_000]]);

  test("ranks by profit and drops low-volume noise", () => {
    const board = buildLeaderboard(
      new Map([
        ["winner", [trade("OPENAI", 10, 9_000, 1)]],
        ["loser", [trade("OPENAI", 10, 11_000, 1)]],
        ["dust", [trade("OPENAI", 0.01, 5, 1)]],
      ]),
      priced,
    );
    expect(board.map((r) => r.owner)).toEqual(["winner", "loser"]);
    expect(board[0]?.pnlUsd).toBeCloseTo(1_000, 9);
  });

  test("excludes wallets whose cost basis is incomplete", () => {
    // Without this filter, selling a pre-existing bag tops the board.
    const board = buildLeaderboard(
      new Map([
        ["bagholder", [trade("OPENAI", -50, -50_000, 1)]],
        ["honest", [trade("OPENAI", 10, 9_000, 1)]],
      ]),
      priced,
    );
    expect(board.map((r) => r.owner)).toEqual(["honest"]);
  });

  test("can rank by return or volume instead", () => {
    const entries = new Map([
      ["big", [trade("OPENAI", 100, 99_000, 1)]],
      ["sharp", [trade("OPENAI", 1, 800, 1)]],
    ]);
    expect(buildLeaderboard(entries, priced, { sortBy: "pnl" })[0]?.owner).toBe("big");
    expect(buildLeaderboard(entries, priced, { sortBy: "return" })[0]?.owner).toBe("sharp");
    expect(buildLeaderboard(entries, priced, { sortBy: "volume" })[0]?.owner).toBe("big");
  });

  test("honours the limit", () => {
    const many = new Map(
      Array.from({ length: 40 }, (_, i) => [`w${i}`, [trade("OPENAI", 10, 9_000 + i, 1)]] as const),
    );
    expect(buildLeaderboard(many, priced, { limit: 5 })).toHaveLength(5);
  });
});

describe("a cost that cannot be believed", () => {
  test("a buy recorded as receiving money is not a profit", () => {
    const pnl = computeTraderPnl("w", [trade("OPENAI", 0.0004, -92.63, 10)], prices);
    expect(pnl.coverageComplete).toBe(false);
    expect(pnl.volumeUsd).toBe(0);
  });

  test("an implied price far from today's is not believed", () => {
    const pnl = computeTraderPnl("w", [trade("OPENAI", 0.01, 400, 10)], prices);
    expect(pnl.coverageComplete).toBe(false);
  });

  test("an ordinary trade with a wide spread still counts", () => {
    const pnl = computeTraderPnl("w", [trade("OPENAI", 1, 1_430, 10)], prices);
    expect(pnl.coverageComplete).toBe(true);
    expect(pnl.netInvestedUsd).toBe(1_430);
  });

  test("such a wallet is kept off the leaderboard", () => {
    const board = buildLeaderboard(
      new Map([["w", [trade("OPENAI", 0.0004, -92.63, 10)]]]),
      prices,
      { minVolumeUsd: 0 },
    );
    expect(board).toHaveLength(0);
  });
});
