/**
 * Raw <-> UI amount conversion for Token-2022 mints carrying the
 * ScaledUiAmount extension.
 *
 * PreStocks mints use this extension to apply share splits without moving
 * tokens: the on-chain balance stays put and the multiplier changes. A client
 * that ignores the multiplier reports balances and prices that are wrong by the
 * multiplier -- for SPACEX (x5) that is 400% too high.
 *
 * The arithmetic here is a deliberate port of
 * `spl-token-2022/interface/src/extension/scaled_ui_amount/mod.rs`. JavaScript
 * numbers are IEEE-754 doubles, the same representation Rust uses for the
 * multiplier and for the `amount as f64` cast, so the port is bit-exact --
 * including the precision loss above 2^53 that the on-chain code also has.
 * Do not "improve" this with decimal math: matching the chain matters more
 * than being more precise than the chain.
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
 * Mirrors `amount_to_ui_amount`: scale first, truncate toward zero, and only
 * then divide by 10^decimals. Truncating after scaling (not before) is what
 * makes this agree with the chain.
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
 * Price per UI share, given a price quoted per raw token.
 *
 * Jupiter's quote endpoint returns raw base units and ignores the multiplier
 * entirely, so a price derived straight from `outAmount` is a price per *raw*
 * token. Dividing by the multiplier converts it to the per-share price a user
 * expects to see.
 */
export function rawPriceToUiPrice(
  rawPrice: number,
  config: ScaledUiAmountConfig,
  unixTimestamp: number,
): number {
  return rawPrice / currentMultiplier(config, unixTimestamp);
}
