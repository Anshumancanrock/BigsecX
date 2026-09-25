import { describe, expect, test } from "bun:test";
import {
  FEE_CHANGE_WINDOW_SLOTS,
  UNCAPPED_FEE,
  calculateEpochFee,
  calculateFee,
  epochFee,
  landingFeeBps,
  pendingFeeChange,
  postFeeAmount,
  preFeeAmount,
  type TransferFee,
  type TransferFeeConfig,
} from "../src/transfer-fee.ts";

const ONE = 10_000n; // ONE_IN_BASIS_POINTS

/**
 * The fixture from `test_transfer_fee_config()` in
 * spl-token-2022/interface/src/extension/transfer_fee/mod.rs, so any drift of
 * the port from the chain fails here.
 */
const OLDER_EPOCH = 1;
const NEWER_EPOCH = 100;
const UPSTREAM: TransferFeeConfig = {
  olderTransferFee: { epoch: OLDER_EPOCH, maximumFee: 10n, transferFeeBasisPoints: 100 },
  newerTransferFee: { epoch: NEWER_EPOCH, maximumFee: 5_000n, transferFeeBasisPoints: 1 },
};

/** A PreStocks fee schedule as read from mainnet. */
const PRESTOCKS: TransferFeeConfig = {
  olderTransferFee: { epoch: 1032, maximumFee: UNCAPPED_FEE, transferFeeBasisPoints: 50 },
  newerTransferFee: { epoch: 1039, maximumFee: UNCAPPED_FEE, transferFeeBasisPoints: 100 },
};

describe("epochFee (port of get_epoch_fee)", () => {
  test("uses the newer schedule from its epoch onward", () => {
    expect(epochFee(UPSTREAM, NEWER_EPOCH).epoch).toBe(NEWER_EPOCH);
    expect(epochFee(UPSTREAM, NEWER_EPOCH + 1).epoch).toBe(NEWER_EPOCH);
    expect(epochFee(UPSTREAM, Number.MAX_SAFE_INTEGER).epoch).toBe(NEWER_EPOCH);
  });

  test("uses the older schedule before it", () => {
    expect(epochFee(UPSTREAM, NEWER_EPOCH - 1).epoch).toBe(OLDER_EPOCH);
    expect(epochFee(UPSTREAM, OLDER_EPOCH).epoch).toBe(OLDER_EPOCH);
    expect(epochFee(UPSTREAM, OLDER_EPOCH + 1).epoch).toBe(OLDER_EPOCH);
  });

  test("PreStocks is still on 50 bps at epoch 1037", () => {
    // Reading newerTransferFee unconditionally would quote 100 bps here,
    // double the rate in force.
    expect(epochFee(PRESTOCKS, 1037).transferFeeBasisPoints).toBe(50);
    expect(epochFee(PRESTOCKS, 1038).transferFeeBasisPoints).toBe(50);
    expect(epochFee(PRESTOCKS, 1039).transferFeeBasisPoints).toBe(100);
  });
});

describe("calculateFee (port of calculate_fee)", () => {
  const fee: TransferFee = { epoch: 0, maximumFee: 5_000n, transferFeeBasisPoints: 1 };

  // Vectors from `calculate_fee_max`.
  test("caps at the maximum fee", () => {
    const max = 5_000n;
    expect(calculateFee(fee, 2n ** 64n - 1n)).toBe(max);
    expect(calculateFee(fee, max * ONE)).toBe(max);
    expect(calculateFee(fee, max * ONE + 1n)).toBe(max);
    expect(calculateFee(fee, max * ONE - 1n)).toBe(max);
  });

  // Vectors from `calculate_fee_min`. These pin the ceiling division: a
  // floor or a round would return 0 for a 1-unit transfer.
  test("rounds up, so any non-zero transfer pays at least one unit", () => {
    expect(calculateFee(fee, 1n)).toBe(1n);
    expect(calculateFee(fee, 2n)).toBe(1n);
    expect(calculateFee(fee, ONE)).toBe(1n);
    expect(calculateFee(fee, ONE + 1n)).toBe(2n);
    expect(calculateFee(fee, 0n)).toBe(0n);
  });

  // Vectors from `calculate_fee_zero`.
  test("a zero rate and a zero cap both mean no fee", () => {
    const zeroRate: TransferFee = { epoch: 0, maximumFee: UNCAPPED_FEE, transferFeeBasisPoints: 0 };
    for (const amount of [0n, 2n ** 64n - 1n, 1n, ONE]) {
      expect(calculateFee(zeroRate, amount)).toBe(0n);
    }
    const zeroCap: TransferFee = { epoch: 0, maximumFee: 0n, transferFeeBasisPoints: 10_000 };
    for (const amount of [0n, 2n ** 64n - 1n, 1n, ONE]) {
      expect(calculateFee(zeroCap, amount)).toBe(0n);
    }
  });
});

describe("preFeeAmount / postFeeAmount", () => {
  const fee = epochFee(PRESTOCKS, 1037); // 50 bps, uncapped

  test("post-fee is what the recipient actually receives", () => {
    // 1 OPENAI raw token at 9 decimals, 50 bps.
    expect(postFeeAmount(fee, 1_000_000_000n)).toBe(995_000_000n);
  });

  test("pre-fee is the amount to send for an exact delivery", () => {
    const target = 995_000_000n;
    const send = preFeeAmount(fee, target);
    expect(postFeeAmount(fee, send)).toBeGreaterThanOrEqual(target);
  });

  test("inverse relationship holds across magnitudes", () => {
    for (const post of [1n, 7n, 1_000n, 999_999n, 1_000_000_000n, 42_000_000_000_000n]) {
      const send = preFeeAmount(fee, post);
      expect(postFeeAmount(fee, send)).toBeGreaterThanOrEqual(post);
    }
  });

  test("the fee never exceeds the amount transferred", () => {
    for (const amount of [1n, 2n, 10n, 12_345n, 10n ** 12n]) {
      expect(calculateFee(fee, amount)).toBeLessThanOrEqual(amount);
    }
  });
});

describe("live PreStocks cost of a round trip", () => {
  test("doubles when epoch 1039 arrives", () => {
    const notional = 1_000_000_000_000n; // 1000 raw tokens at 9 decimals
    const today = calculateEpochFee(PRESTOCKS, 1037, notional);
    const after = calculateEpochFee(PRESTOCKS, 1039, notional);
    expect(today).toBe(5_000_000_000n); // 0.5%
    expect(after).toBe(10_000_000_000n); // 1.0%
    expect(after).toBe(today * 2n);
  });
});

describe("pendingFeeChange", () => {
  test("announces the scheduled increase while it is still pending", () => {
    expect(pendingFeeChange(PRESTOCKS, 1037)).toEqual({
      fromBps: 50,
      toBps: 100,
      atEpoch: 1039,
    });
  });

  test("goes quiet once the increase is live", () => {
    expect(pendingFeeChange(PRESTOCKS, 1039)).toBeNull();
    expect(pendingFeeChange(PRESTOCKS, 1200)).toBeNull();
  });

  test("ignores a schedule that changes nothing", () => {
    const flat: TransferFeeConfig = {
      olderTransferFee: { epoch: 1, maximumFee: UNCAPPED_FEE, transferFeeBasisPoints: 50 },
      newerTransferFee: { epoch: 9, maximumFee: UNCAPPED_FEE, transferFeeBasisPoints: 50 },
    };
    expect(pendingFeeChange(flat, 1)).toBeNull();
  });
});

describe("the fee a transaction built now pays when it lands", () => {
  // A mainnet schedule: 1% until epoch 1043, then 3%.
  const change = { toBps: 300, atEpoch: 1043 };

  test("is the fee in force when nothing is scheduled", () => {
    expect(landingFeeBps(100, null, { epoch: 1042, slotsLeft: 10 })).toBe(100);
  });

  test("is the fee in force while the change is more than the window away", () => {
    expect(landingFeeBps(100, change, { epoch: 1042, slotsLeft: 227_083 })).toBe(100);
    expect(landingFeeBps(100, change, { epoch: 1042, slotsLeft: FEE_CHANGE_WINDOW_SLOTS + 1 })).toBe(100);
  });

  test("is the new fee in the last minutes before the change", () => {
    expect(landingFeeBps(100, change, { epoch: 1042, slotsLeft: FEE_CHANGE_WINDOW_SLOTS })).toBe(300);
    expect(landingFeeBps(100, change, { epoch: 1042, slotsLeft: 40 })).toBe(300);
  });

  test("is the new fee once the cluster has passed the change, whatever the snapshot said", () => {
    expect(landingFeeBps(100, change, { epoch: 1043, slotsLeft: 431_000 })).toBe(300);
  });

  test("assumes the higher fee when the cluster's position is unknown", () => {
    expect(landingFeeBps(100, change, null)).toBe(300);
  });

  test("never allows for less than the fee in force when the fee is falling", () => {
    expect(landingFeeBps(300, { toBps: 100, atEpoch: 1043 }, { epoch: 1042, slotsLeft: 10 })).toBe(300);
  });

  test("ignores a change two epochs out", () => {
    expect(landingFeeBps(100, { toBps: 300, atEpoch: 1044 }, { epoch: 1042, slotsLeft: 10 })).toBe(100);
  });
});
