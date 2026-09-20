import { describe, expect, test } from "bun:test";
import { USDC_MINT, WSOL_MINT } from "../src/trades.ts";

/**
 * Mirrors `tradeValueUsd` in apps/indexer/src/job.ts.
 *
 * Duplicated here rather than imported because the indexer is an app, not a
 * library. The rule it encodes is what the leaderboard depends on, so it is
 * worth pinning: an earlier version marked every trade at the current
 * snapshot price, which made a buy and a later sell of the same shares price
 * identically and reconstructed everyone's profit as roughly zero.
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
    // Wallet's USDC fell by 500.
    expect(tradeValueUsd(-500_000_000n, null, null, null)).toBeCloseTo(500, 9);
  });

  test("a sell returns, so it is negative", () => {
    expect(tradeValueUsd(600_000_000n, null, null, null)).toBeCloseTo(-600, 9);
  });

  test("falls back to the SOL leg, which most routes actually use", () => {
    // Spent 2 SOL at $200.
    expect(tradeValueUsd(null, -2_000_000_000n, null, 200)).toBeCloseTo(400, 9);
  });

  test("prefers the stablecoin leg when both moved", () => {
    // An intermediate SOL hop can leave a residue; the stablecoin is the
    // honest measure of what the wallet paid.
    expect(tradeValueUsd(-500_000_000n, -2_000_000_000n, null, 200)).toBeCloseTo(500, 9);
  });

  test("a buy and a later sell of the same shares do not net to zero", () => {
    // The failure the old snapshot-price rule produced. Different cash
    // amounts must survive into the accounting or profit is unmeasurable.
    const buy = tradeValueUsd(-1_000_000_000n, null, null, null);
    const sell = tradeValueUsd(1_200_000_000n, null, null, null);
    expect((buy ?? 0) + (sell ?? 0)).toBeCloseTo(-200, 9);
  });

  test("reports no cost when neither cash leg is present", () => {
    // A plain transfer, or a route through a token we do not price.
    expect(tradeValueUsd(null, null, null, 200)).toBeNull();
    expect(tradeValueUsd(0n, 0n, 0n, 200)).toBeNull();
  });

  test("reports no cost when the SOL price is unavailable", () => {
    expect(tradeValueUsd(null, -2_000_000_000n, null, null)).toBeNull();
  });

  test("values a SOL-routed swap from native lamports", () => {
    // Measured on mainnet: three consecutive pool trades showed usdc=0 and
    // wsol=0 while moving 2.75, 0.25 and 1.01 SOL natively, because Jupiter
    // wraps and unwraps inside the transaction. Without this the leaderboard
    // prices none of them.
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
