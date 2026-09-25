/**
 * Raw/UI conversion for Token-2022 ScaledUiAmount mints, which apply splits by
 * changing a multiplier instead of moving tokens. Ported from
 * `spl-token-2022/interface/src/extension/scaled_ui_amount/mod.rs`; it stays in
 * f64 like the chain so results match bit for bit, including loss above 2^53.
 */

/** On-chain ScaledUiAmount extension state, as returned by jsonParsed RPC. */
export interface ScaledUiAmountConfig {
  /** Multiplier in force before `newMultiplierEffectiveTimestamp`. */
  readonly multiplier: number;
  /** Multiplier in force from `newMultiplierEffectiveTimestamp` onward. */
  readonly newMultiplier: number;
  /** Unix seconds at which `newMultiplier` takes over. */
  readonly newMultiplierEffectiveTimestamp: number;
}

/**
 * Select the multiplier in force at `unixTimestamp`.
 *
 * Mirrors `ScaledUiAmountConfig::current_multiplier`. The comparison is `>=`,
 * so the new multiplier applies on the effective second itself.
 */
export function currentMultiplier(
  config: ScaledUiAmountConfig,
  unixTimestamp: number,
): number {
  return unixTimestamp >= config.newMultiplierEffectiveTimestamp
    ? config.newMultiplier
    : config.multiplier;
}

/**
 * Convert a raw base-unit amount to its UI value.
 *
 * Mirrors `amount_to_ui_amount`: scale, truncate toward zero, then divide by
 * 10^decimals. Truncating after scaling is what matches the chain.
 */
export function rawToUi(
  raw: bigint,
  decimals: number,
  config: ScaledUiAmountConfig,
  unixTimestamp: number,
): number {
  const scaled = Number(raw) * currentMultiplier(config, unixTimestamp);
  return Math.trunc(scaled) / 10 ** decimals;
}

/**
 * Convert a UI amount back to raw base units.
 *
 * Mirrors `try_ui_amount_into_amount`, which divides by the *total* multiplier
 * (multiplier / 10^decimals) and truncates once at the end. Truncating early
 * produces `inf` for large values, which is why the division happens first.
 */
export function uiToRaw(
  ui: number,
  decimals: number,
  config: ScaledUiAmountConfig,
  unixTimestamp: number,
): bigint {
  const totalMultiplier = currentMultiplier(config, unixTimestamp) / 10 ** decimals;
  const amount = ui / totalMultiplier;
  if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`uiToRaw: ${ui} is out of range for this mint`);
  }
  return BigInt(Math.trunc(amount));
}

/** The identity config, for mints whose multiplier has never been set. */
export const UNSCALED: ScaledUiAmountConfig = {
  multiplier: 1,
  newMultiplier: 1,
  newMultiplierEffectiveTimestamp: 0,
};

/**
 * Price per UI share, given a price quoted per raw token. Jupiter quotes raw
 * base units, so a price from `outAmount` is per raw token until divided by the
 * multiplier.
 */
export function rawPriceToUiPrice(
  rawPrice: number,
  config: ScaledUiAmountConfig,
  unixTimestamp: number,
): number {
  return rawPrice / currentMultiplier(config, unixTimestamp);
}
