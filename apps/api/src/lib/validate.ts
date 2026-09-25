/**
 * Request validation. Malformed input is refused at the edge with a 400;
 * otherwise a value such as NaN travels through sizing and surfaces deep in
 * the planner as a confusing success.
 */

import { bySymbol, type Weight } from "@ps/core";

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

/** Largest basket that will be priced. */
const MAX_WEIGHTS = 32;
/**
 * Largest claimed holding, in UI shares. Catches raw base units sent by
 * mistake, and values that would overflow to Infinity once multiplied by a price.
 */
const MAX_HOLDING_UI = 1e12;
/** Positions a caller may claim. The universe has eight tokens. */
const MAX_HOLDINGS = 32;
/** Above this, quotes are meaningless against $2.6M of total liquidity. */
const MAX_DEPLOY_USD = 10_000_000;

/** Parse a JSON object body, turning malformed JSON into a 400 rather than a 500. */
export async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequest("body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/**
 * Coerce a request field to a number, or throw BadRequest. Only a finite
 * number, or a string that is entirely one, is accepted: `Number()` alone
 * turns true, [], "" and null into real values. Every numeric field uses this.
 */
export function toNumber(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BadRequest(`${field} must be a finite number`);
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") throw new BadRequest(`${field} must be a number`);
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) throw new BadRequest(`${field} must be a finite number`);
    return parsed;
  }
  throw new BadRequest(`${field} must be a number`);
}

export function requireFiniteUsd(
  value: unknown,
  field: string,
  { min = 0, max = MAX_DEPLOY_USD }: { min?: number; max?: number } = {},
): number {
  if (value === undefined || value === null) throw new BadRequest(`${field} is required`);
  const parsed = toNumber(value, field);
  if (parsed < min) throw new BadRequest(`${field} must be at least ${min}`);
  if (parsed > max) throw new BadRequest(`${field} must be at most ${max}`);
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
 * Validate caller-supplied weights. Unknown symbols are rejected rather than
 * dropped, so the basket priced is the basket asked for.
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

    const parsed = toNumber(weight, "weight");
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequest(`weight for ${upper} must be a positive finite number`);
    }
    total += parsed;
    weights.push({ symbol: upper, weight: parsed });
  }

  if (!Number.isFinite(total) || total <= 0) {
    // Finite weights can still sum to Infinity, which would normalise every
    // weight to NaN.
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
    const parsed = toNumber(uiAmount, "uiAmount");
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
  // An empty string is an unset form field, not a request for zero.
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = toNumber(value, field);
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * Clean a string anyone can publish. After NFC normalisation, bidi overrides,
 * invisible characters and control characters are removed: they are renderer
 * instructions rather than markup, so escaping cannot stop them spoofing a name.
 */
export function sanitizeDisplayText(value: string): string {
  return value
    .normalize("NFC")
    // C0 and C1 control characters, including newline and tab.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    // Bidi overrides and isolates, and the directional marks, including the
    // Arabic letter mark.
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    // Characters that draw nothing: zero-width space and non-joiner, BOM, soft
    // hyphen, word joiner and invisible operators, deprecated format controls,
    // Mongolian and Khmer invisible signs, combining grapheme joiner, Hangul
    // and braille blanks, and tag characters.
    .replace(
      /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u2060-\u2064\u206A-\u206F\u2800\u3164\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}]/gu,
      "",
    )
    // Unicode whitespace that is not a plain space, plus runs of spaces.
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, " ")
    .split(" ")
    .map(keepEmojiJoiners)
    .join(" ")
    .trim();
}

const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
/** A variation selector or skin tone, which sits between an emoji and a joiner. */
const EMOJI_SUFFIX = /^[\uFE0F\u{1F3FB}-\u{1F3FF}]$/u;

/**
 * Drop zero-width joiners except between two emoji, where the joiner makes
 * them one glyph. Walks code points because a regex lookbehind mismatches next
 * to astral characters.
 */
function keepEmojiJoiners(text: string): string {
  if (!text.includes("\u200D")) return text;
  const chars = [...text];
  return chars
    .filter((ch, i) => {
      if (ch !== "\u200D") return true;
      let back = i - 1;
      while (back >= 0 && EMOJI_SUFFIX.test(chars[back]!)) back--;
      const before = chars[back];
      const after = chars[i + 1];
      return before !== undefined && after !== undefined && PICTOGRAPH.test(before) && PICTOGRAPH.test(after);
    })
    .join("");
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Length in graphemes, so an emoji made of several code points counts once. */
export function displayLength(value: string): number {
  let count = 0;
  for (const _ of graphemes.segment(value)) count++;
  return count;
}

/**
 * Whether any character carries more than `maxMarks` combining marks. A
 * stacked character draws over the lines around it; real text uses a few.
 */
export function overstacked(value: string, maxMarks = 3): boolean {
  for (const { segment } of graphemes.segment(value)) {
    if ((segment.match(/\p{M}/gu)?.length ?? 0) > maxMarks) return true;
  }
  return false;
}
