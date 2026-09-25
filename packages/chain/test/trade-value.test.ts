import { describe, expect, test } from "bun:test";
import { USDC_MINT, WSOL_MINT } from "../src/trades.ts";

/**
 * Mirrors `tradeValueUsd` in packages/market/src/trade-rows.ts, which this
 * package cannot import (@ps/market depends on @ps/chain). The leaderboard
 * relies on its rule: a trade is valued by the cash that moved, not a snapshot
 * price, so a buy and a later sell of the same shares keep different values.
 */
const MIN_LAMPORT_TRADE = 5_000_000n;

function tradeValueUsd(
  usdcDeltaRaw: bigint | null,
  wsolDeltaRaw: bigint | null,
  lamportDeltaRaw: bigint | null,
  solUsd: number | null,
): number | null {
  if (usdcDeltaRaw !== null && usdcDeltaRaw !== 0n) return -Number(usdcDeltaRaw) / 1e6;
  if (wsolDeltaRaw !== null && wsolDeltaRaw !== 0n && solUsd !== null && solUsd > 0) {
    return (-Number(wsolDeltaRaw) / 1e9) * solUsd;
  }
  if (
    lamportDeltaRaw !== null &&
    solUsd !== null &&
    solUsd > 0 &&
    (lamportDeltaRaw > MIN_LAMPORT_TRADE || lamportDeltaRaw < -MIN_LAMPORT_TRADE)
  ) {
    return (-Number(lamportDeltaRaw) / 1e9) * solUsd;
  }
  return null;
}

describe("trade valuation", () => {
  test("a buy spends, so it is positive", () => {
    expect(tradeValueUsd(-500_000_000n, null, null, null)).toBeCloseTo(500, 9);
  });

  test("a sell returns, so it is negative", () => {
    expect(tradeValueUsd(600_000_000n, null, null, null)).toBeCloseTo(-600, 9);
  });

  test("falls back to the SOL leg, which most routes actually use", () => {
    expect(tradeValueUsd(null, -2_000_000_000n, null, 200)).toBeCloseTo(400, 9);
  });

  test("prefers the stablecoin leg when both moved", () => {
    expect(tradeValueUsd(-500_000_000n, -2_000_000_000n, null, 200)).toBeCloseTo(500, 9);
  });

  test("a buy and a later sell of the same shares do not net to zero", () => {
    // Different cash amounts must survive into the accounting, or profit
    // cannot be measured.
    const buy = tradeValueUsd(-1_000_000_000n, null, null, null);
    const sell = tradeValueUsd(1_200_000_000n, null, null, null);
    expect((buy ?? 0) + (sell ?? 0)).toBeCloseTo(-200, 9);
  });

  test("reports no cost when neither cash leg is present", () => {
    expect(tradeValueUsd(null, null, null, 200)).toBeNull();
    expect(tradeValueUsd(0n, 0n, 0n, 200)).toBeNull();
  });

  test("reports no cost when the SOL price is unavailable", () => {
    expect(tradeValueUsd(null, -2_000_000_000n, null, null)).toBeNull();
  });

  test("values a SOL-routed swap from native lamports", () => {
    // Amounts from mainnet SOL-routed swaps: Jupiter wraps and unwraps SOL
    // inside the transaction, so only native lamports show the movement.
    expect(tradeValueUsd(null, null, 2_751_289_640n, 100)).toBeCloseTo(-275.128964, 6);
    expect(tradeValueUsd(null, null, -1_013_361_096n, 100)).toBeCloseTo(101.3361096, 6);
  });

  test("ignores a lamport change too small to be consideration", () => {
    // Opening an associated token account costs about 0.00204 SOL; that is
    // account churn, not a trade.
    expect(tradeValueUsd(null, null, 2_040_000n, 100)).toBeNull();
    expect(tradeValueUsd(null, null, -2_040_000n, 100)).toBeNull();
  });

  test("the cash mints are the ones the parser watches", () => {
    expect(USDC_MINT).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(WSOL_MINT).toBe("So11111111111111111111111111111111111111112");
  });
});
