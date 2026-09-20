/**
 * Request validation.
 *
 * Without this, a non-numeric `deployUsd` propagates as NaN through weighting
 * and sizing until it reaches `BigInt(Math.round(NaN))` deep inside the
 * planner, and the caller gets HTTP 200 with a leg of `"usd": null` and the
 * reason "could not quote: Not an integer". Rejecting at the edge is the
 * difference between a clear 400 and a confusing success.
 */

import { bySymbol, type Weight } from "@ps/core";

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

/** Largest basket we will price. Guards against a request with 10,000 legs. */
const MAX_WEIGHTS = 32;
/**
 * Largest position we will accept as a claimed holding.
 *
 * Without a ceiling, a frontend passing raw base units instead of UI shares
 * sizes an order in the billions, and a value near Number.MAX_VALUE overflows
 * to Infinity once multiplied by a price -- which then propagates through
 * weighting and reaches BigInt conversion as the same "Not an integer" the
 * deployUsd guard exists to prevent.
 */
const MAX_HOLDING_UI = 1e12;
/** Positions a caller may claim. The universe has eight tokens. */
const MAX_HOLDINGS = 32;
/** Above this, quotes are meaningless against $2.6M of total liquidity. */
const MAX_DEPLOY_USD = 10_000_000;

export function requireFiniteUsd(value: unknown, field: string, { min = 0 } = {}): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new BadRequest(`${field} must be a finite number`);
  if (parsed < min) throw new BadRequest(`${field} must be at least ${min}`);
  if (parsed > MAX_DEPLOY_USD) {
    throw new BadRequest(`${field} must be at most ${MAX_DEPLOY_USD}`);
  }
  return parsed;
}

export function requireBase58Address(value: unknown, field: string): string {
  if (typeof value !== "string") throw new BadRequest(`${field} is required`);
  // Base58 alphabet, and the length range a Solana public key encodes to.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new BadRequest(`${field} is not a valid Solana address`);
  }
  return value;
}

/**
 * Validate caller-supplied weights.
 *
 * Unknown symbols are rejected rather than deferred. A basket that quietly
 * drops a constituent is not the basket the caller asked for, and they would
 * have no way to tell from a 200.
 */
export function parseWeights(value: unknown): Weight[] {
  if (!Array.isArray(value)) throw new BadRequest("weights must be an array");
  if (value.length === 0) throw new BadRequest("weights must not be empty");
  if (value.length > MAX_WEIGHTS) {
    throw new BadRequest(`weights must contain at most ${MAX_WEIGHTS} entries`);
  }

  const seen = new Set<string>();
  const weights: Weight[] = [];
  let total = 0;

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new BadRequest("each weight must be an object");
    }
    const { symbol, weight } = entry as { symbol?: unknown; weight?: unknown };

    if (typeof symbol !== "string" || !bySymbol(symbol)) {
      throw new BadRequest(`unknown symbol ${JSON.stringify(symbol)}`);
    }
    const upper = symbol.toUpperCase();
    if (seen.has(upper)) throw new BadRequest(`duplicate symbol ${upper}`);
    seen.add(upper);

    const parsed = typeof weight === "number" ? weight : Number(weight);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequest(`weight for ${upper} must be a positive finite number`);
    }
    total += parsed;
    weights.push({ symbol: upper, weight: parsed });
  }

  if (!Number.isFinite(total) || total <= 0) {
    // Individually finite weights can still sum to Infinity, which survives a
    // "> 0" check and then normalises every weight to NaN, yielding a
    // successful but completely empty plan.
    throw new BadRequest("weights must sum to a positive finite number");
  }
  return weights;
}

/** Validate holdings supplied by a caller describing their current position. */
export function parseHoldings(
  value: unknown,
): { readonly symbol: string; readonly uiAmount: number }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequest("holdings must be an array");
  if (value.length > MAX_HOLDINGS) {
    throw new BadRequest(`holdings must contain at most ${MAX_HOLDINGS} entries`);
  }

  return value.map((entry) => {
    const { symbol, uiAmount } = (entry ?? {}) as { symbol?: unknown; uiAmount?: unknown };
    if (typeof symbol !== "string" || !bySymbol(symbol)) {
      throw new BadRequest(`unknown symbol ${JSON.stringify(symbol)} in holdings`);
    }
    const parsed = typeof uiAmount === "number" ? uiAmount : Number(uiAmount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequest(`uiAmount for ${symbol} must be a non-negative finite number`);
    }
    if (parsed > MAX_HOLDING_UI) {
      throw new BadRequest(
        `uiAmount for ${symbol} exceeds ${MAX_HOLDING_UI}; it should be shares, not base units`,
      );
    }
    return { symbol: symbol.toUpperCase(), uiAmount: parsed };
  });
}

export function requireInt(
  value: unknown,
  field: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new BadRequest(`${field} must be a number`);
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
