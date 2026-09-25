/**
 * Token-2022 transfer-fee arithmetic, ported from
 * `spl-token-2022/interface/src/extension/transfer_fee/mod.rs`. The fee is a
 * ceiling division, and of a mint's two schedules `newerTransferFee` applies
 * only from its epoch; `olderTransferFee` is live until then.
 */

const MAX_FEE_BASIS_POINTS = 10_000n;
/** Sentinel used by PreStocks mints to mean "no cap". */
export const UNCAPPED_FEE = 18_446_744_073_709_551_615n; // u64::MAX

/** One of the two fee schedules on a mint. */
export interface TransferFee {
  /** First epoch in which this schedule applies. */
  readonly epoch: number;
  /** Fee rate in basis points. */
  readonly transferFeeBasisPoints: number;
  /** Absolute cap on the fee, in raw base units. */
  readonly maximumFee: bigint;
}

/** On-chain TransferFeeConfig extension state. */
export interface TransferFeeConfig {
  readonly olderTransferFee: TransferFee;
  readonly newerTransferFee: TransferFee;
}

/** `ceil(numerator / denominator)` over bigints. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Select the fee schedule in force at `epoch`.
 *
 * Mirrors `TransferFeeConfig::get_epoch_fee`.
 */
export function epochFee(config: TransferFeeConfig, epoch: number): TransferFee {
  return epoch >= config.newerTransferFee.epoch
    ? config.newerTransferFee
    : config.olderTransferFee;
}

/**
 * Fee withheld from a transfer of `preFeeAmount` raw units.
 *
 * Mirrors `TransferFee::calculate_fee`.
 */
export function calculateFee(fee: TransferFee, preFeeAmount: bigint): bigint {
  const bps = BigInt(fee.transferFeeBasisPoints);
  if (bps === 0n || preFeeAmount === 0n) return 0n;
  const raw = ceilDiv(preFeeAmount * bps, MAX_FEE_BASIS_POINTS);
  return raw < fee.maximumFee ? raw : fee.maximumFee;
}

/**
 * Amount that actually lands in the recipient account.
 *
 * Mirrors `calculate_post_fee_amount`. This is the number a UI should show as
 * "you receive", not the pool output.
 */
export function postFeeAmount(fee: TransferFee, preFeeAmount: bigint): bigint {
  return preFeeAmount - calculateFee(fee, preFeeAmount);
}

/**
 * Amount to send so that exactly `postFeeAmount` arrives.
 *
 * Mirrors `calculate_pre_fee_amount`, including its cap handling. Where
 * rounding makes the answer ambiguous the smaller amount is chosen, matching
 * the on-chain comment.
 */
export function preFeeAmount(fee: TransferFee, post: bigint): bigint {
  const bps = BigInt(fee.transferFeeBasisPoints);
  if (bps === 0n) return post;
  if (post === 0n) return 0n;
  if (bps === MAX_FEE_BASIS_POINTS) return fee.maximumFee + post;

  const rawPreFee = ceilDiv(post * MAX_FEE_BASIS_POINTS, MAX_FEE_BASIS_POINTS - bps);
  return rawPreFee - post >= fee.maximumFee ? post + fee.maximumFee : rawPreFee;
}

/** Convenience: fee for an amount at a given epoch. */
export function calculateEpochFee(
  config: TransferFeeConfig,
  epoch: number,
  preFeeAmount_: bigint,
): bigint {
  return calculateFee(epochFee(config, epoch), preFeeAmount_);
}

/**
 * Describe a scheduled fee change that is not yet live. Null when the newer
 * schedule is already live or charges the same rate as the older one.
 */
export function pendingFeeChange(
  config: TransferFeeConfig,
  currentEpoch: number,
): { readonly fromBps: number; readonly toBps: number; readonly atEpoch: number } | null {
  const { olderTransferFee: older, newerTransferFee: newer } = config;
  if (currentEpoch >= newer.epoch) return null;
  if (older.transferFeeBasisPoints === newer.transferFeeBasisPoints) return null;
  return {
    fromBps: older.transferFeeBasisPoints,
    toBps: newer.transferFeeBasisPoints,
    atEpoch: newer.epoch,
  };
}

/**
 * How close to an epoch's end a scheduled fee change is allowed for: 3,000
 * slots (about 20 minutes) covers a blockhash's ~150-block life plus slow
 * signing, and is small against a two-day epoch.
 */
export const FEE_CHANGE_WINDOW_SLOTS = 3_000;

/**
 * The transfer fee, in basis points, a transaction built now may pay when it
 * lands. The higher of the current and scheduled fees applies within
 * `windowSlots` of a change due next epoch (the transaction may land after the
 * boundary), once the change has passed, or when the clock is unknown.
 */
export function landingFeeBps(
  inForceBps: number,
  pending: { readonly toBps: number; readonly atEpoch: number } | null,
  clock: { readonly epoch: number; readonly slotsLeft: number } | null,
  windowSlots = FEE_CHANGE_WINDOW_SLOTS,
): number {
  if (!pending) return inForceBps;
  const higher = Math.max(inForceBps, pending.toBps);
  if (!clock || clock.epoch >= pending.atEpoch) return higher;
  if (clock.epoch + 1 === pending.atEpoch && clock.slotsLeft <= windowSlots) return higher;
  return inForceBps;
}
