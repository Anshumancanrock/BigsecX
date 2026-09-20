/**
 * Strategies: portfolios somebody authored and can publish.
 *
 * A thematic index, a user's own basket and a portfolio someone copies are
 * the same object with different authors. Keeping one primitive means
 * weighting, drift, execution and performance are written once rather than
 * three times that drift apart.
 *
 * This module owns the rules a strategy must satisfy before it can be saved.
 * Validation lives here, in pure code, rather than at the API edge: the
 * indexer builds strategies too, and a rule enforced in only one caller is a
 * rule that eventually is not enforced.
 */

import { capWeights, normalizeWeights, type Portfolio, type Weight } from "./portfolio.ts";
import { UNIVERSE, bySymbol, type Sector } from "./universe.ts";

export type RebalanceFrequency = "manual" | "daily" | "weekly" | "monthly";

/**
 * Limits a strategy promises to keep.
 *
 * These are the author's commitments to whoever buys the basket, so they are
 * stored with the strategy and checked on every rebalance rather than applied
 * once at creation.
 */
export interface Guardrails {
  /** No single position may exceed this fraction. */
  readonly maxWeight: number;
  /** A position below this is not worth its share of the fees. */
  readonly minWeight: number;
  /** Optional ceiling on any one sector's combined weight. */
  readonly maxSectorWeight?: number;
  /** Rebalance once any position drifts this far from target, in bps. */
  readonly driftBps: number;
}

export const DEFAULT_GUARDRAILS: Guardrails = {
  maxWeight: 0.4,
  minWeight: 0.05,
  driftBps: 300,
};

export interface StrategyDraft {
  readonly name: string;
  readonly description?: string;
  /** Wallet that authored it. Absent for system indexes. */
  readonly creator?: string;
  readonly constituents: readonly Weight[];
  readonly guardrails?: Partial<Guardrails>;
  readonly rebalance?: RebalanceFrequency;
}

export interface Strategy extends Portfolio {
  readonly description: string;
  readonly creator: string | null;
  readonly guardrails: Guardrails;
  readonly rebalance: RebalanceFrequency;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly published: boolean;
}

/** A strategy cannot hold more names than exist. */
export const MAX_CONSTITUENTS = UNIVERSE.length;
/** One holding is a position, not a basket. */
export const MIN_CONSTITUENTS = 2;
export const MAX_NAME_LENGTH = 60;
export const MAX_DESCRIPTION_LENGTH = 280;

export class StrategyInvalid extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("; "));
    this.name = "StrategyInvalid";
  }
}

/**
 * Fill in guardrails the author did not set.
 *
 * The default cap adapts to the basket size, because a fixed one describes an
 * impossible basket for small baskets: two positions cannot sum to 100% under
 * a 40% cap, and a two-name basket is perfectly legitimate -- Prediction
 * Markets is exactly Kalshi and Polymarket at half each.
 *
 * An explicitly chosen cap is never widened. The author asked for it, and
 * quietly raising it would ship an allocation they did not agree to; if it is
 * infeasible they are told so.
 */
function resolveGuardrails(
  partial: Partial<Guardrails> | undefined,
  count: number,
): Guardrails {
  const equalSplit = count > 0 ? 1 / count : 1;
  return {
    ...DEFAULT_GUARDRAILS,
    maxWeight: partial?.maxWeight ?? Math.max(DEFAULT_GUARDRAILS.maxWeight, equalSplit),
    minWeight: partial?.minWeight ?? Math.min(DEFAULT_GUARDRAILS.minWeight, equalSplit),
    ...(partial?.maxSectorWeight !== undefined ? { maxSectorWeight: partial.maxSectorWeight } : {}),
    ...(partial?.driftBps !== undefined ? { driftBps: partial.driftBps } : {}),
  };
}

/**
 * Check guardrails are satisfiable before checking anything against them.
 *
 * A cap below an equal split, or a floor above one, describes a basket that
 * cannot exist. Reporting that as "position too large" would send the author
 * to adjust the wrong number.
 */
function guardrailProblems(rails: Guardrails, count: number): string[] {
  const problems: string[] = [];

  if (!(rails.maxWeight > 0 && rails.maxWeight <= 1)) {
    problems.push("maxWeight must be between 0 and 1");
  }
  if (!(rails.minWeight >= 0 && rails.minWeight < 1)) {
    problems.push("minWeight must be at least 0 and below 1");
  }
  if (rails.minWeight >= rails.maxWeight) {
    problems.push("minWeight must be below maxWeight");
  }
  if (!Number.isFinite(rails.driftBps) || rails.driftBps < 0 || rails.driftBps > 10_000) {
    problems.push("driftBps must be between 0 and 10000");
  }
  if (rails.maxSectorWeight !== undefined && !(rails.maxSectorWeight > 0 && rails.maxSectorWeight <= 1)) {
    problems.push("maxSectorWeight must be between 0 and 1");
  }

  // Feasibility: the caps have to admit a basket that sums to one.
  if (problems.length === 0) {
    if (rails.maxWeight * count < 1 - 1e-12) {
      problems.push(
        `${count} positions cannot sum to 100% under a ${(rails.maxWeight * 100).toFixed(0)}% cap`,
      );
    }
    if (rails.minWeight * count > 1 + 1e-12) {
      problems.push(
        `${count} positions cannot sum to 100% above a ${(rails.minWeight * 100).toFixed(0)}% floor`,
      );
    }
  }
  return problems;
}

/** Combined weight per sector. A token in two sectors counts in both. */
export function sectorExposure(weights: readonly Weight[]): Map<Sector, number> {
  const exposure = new Map<Sector, number>();
  for (const { symbol, weight } of weights) {
    for (const sector of bySymbol(symbol)?.sectors ?? []) {
      exposure.set(sector, (exposure.get(sector) ?? 0) + weight);
    }
  }
  return exposure;
}

/**
 * Validate a draft and return the strategy it describes.
 *
 * Weights are normalised and then capped, so an author can express intent in
 * any units -- percentages, dollars, arbitrary scores -- and still get a
 * basket that sums to one and respects the cap.
 *
 * Throws with every problem at once. Returning only the first sends the
 * author round the loop once per mistake.
 */
export function buildStrategy(
  draft: StrategyDraft,
  options: { readonly id: string; readonly now: Date; readonly published?: boolean },
): Strategy {
  const problems: string[] = [];

  const name = draft.name?.trim() ?? "";
  if (name.length === 0) problems.push("name is required");
  if (name.length > MAX_NAME_LENGTH) {
    problems.push(`name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  const description = draft.description?.trim() ?? "";
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  const constituents = draft.constituents ?? [];
  if (constituents.length < MIN_CONSTITUENTS) {
    problems.push(`a strategy needs at least ${MIN_CONSTITUENTS} constituents`);
  }
  if (constituents.length > MAX_CONSTITUENTS) {
    problems.push(`a strategy may hold at most ${MAX_CONSTITUENTS} constituents`);
  }

  const seen = new Set<string>();
  for (const entry of constituents) {
    const symbol = entry.symbol?.toUpperCase?.() ?? "";
    if (!bySymbol(symbol)) {
      problems.push(`unknown symbol ${JSON.stringify(entry.symbol)}`);
      continue;
    }
    if (seen.has(symbol)) problems.push(`duplicate symbol ${symbol}`);
    seen.add(symbol);
    if (!Number.isFinite(entry.weight) || entry.weight <= 0) {
      problems.push(`weight for ${symbol} must be a positive finite number`);
    }
  }

  const rails = resolveGuardrails(draft.guardrails, seen.size);
  problems.push(...guardrailProblems(rails, seen.size));

  // Stop here when the inputs cannot be weighted at all; anything further
  // would report consequences of the problems already listed.
  if (problems.length > 0) throw new StrategyInvalid(problems);

  const normalized = normalizeWeights(
    constituents.map((c) => ({ symbol: c.symbol.toUpperCase(), weight: c.weight })),
  );
  const weights = capWeights(normalized, rails.maxWeight);

  // The floor is a rejection, not a correction: raising a position to meet it
  // would silently change the allocation the author asked for.
  const below = weights.filter((w) => w.weight < rails.minWeight - 1e-12);
  if (below.length > 0) {
    problems.push(
      `below the ${(rails.minWeight * 100).toFixed(0)}% floor: ` +
        below.map((w) => `${w.symbol} ${(w.weight * 100).toFixed(1)}%`).join(", "),
    );
  }

  if (rails.maxSectorWeight !== undefined) {
    for (const [sector, exposure] of sectorExposure(weights)) {
      if (exposure > rails.maxSectorWeight + 1e-12) {
        problems.push(
          `${sector} exposure ${(exposure * 100).toFixed(1)}% exceeds the ` +
            `${(rails.maxSectorWeight * 100).toFixed(0)}% sector cap`,
        );
      }
    }
  }

  if (problems.length > 0) throw new StrategyInvalid(problems);

  return {
    id: options.id,
    kind: draft.creator ? "user" : "index",
    name,
    description,
    creator: draft.creator ?? null,
    weights,
    guardrails: rails,
    rebalance: draft.rebalance ?? "manual",
    createdAt: options.now,
    updatedAt: options.now,
    published: options.published ?? false,
  };
}

/**
 * Whether a holding has drifted far enough from target to be worth trading.
 *
 * Drift is measured in absolute weight, so a 3% threshold means three points
 * of the portfolio, not three percent of the position. Rebalancing on smaller
 * moves spends spread and transfer fee to correct noise -- which in a market
 * with roughly $2.6M of total depth costs more than the drift does.
 */
export function driftExceeded(
  current: readonly Weight[],
  target: readonly Weight[],
  driftBps: number,
): { readonly exceeded: boolean; readonly worst: { symbol: string; driftBps: number } | null } {
  const currentBySymbol = new Map(current.map((w) => [w.symbol, w.weight]));
  const symbols = new Set([...currentBySymbol.keys(), ...target.map((w) => w.symbol)]);

  let worst: { symbol: string; driftBps: number } | null = null;
  for (const symbol of symbols) {
    const held = currentBySymbol.get(symbol) ?? 0;
    const want = target.find((w) => w.symbol === symbol)?.weight ?? 0;
    const bps = Math.abs(want - held) * 10_000;
    if (!worst || bps > worst.driftBps) worst = { symbol, driftBps: bps };
  }
  return { exceeded: worst !== null && worst.driftBps > driftBps, worst };
}

/** Milliseconds between scheduled rebalances, or null when manual. */
export function rebalanceIntervalMs(frequency: RebalanceFrequency): number | null {
  switch (frequency) {
    case "manual":
      return null;
    case "daily":
      return 24 * 60 * 60 * 1000;
    case "weekly":
      return 7 * 24 * 60 * 60 * 1000;
    case "monthly":
      // Calendar months vary; 30 days is the convention for a drift-driven
      // schedule where the exact boundary does not matter.
      return 30 * 24 * 60 * 60 * 1000;
  }
}

/**
 * Overlap between several strategies a user holds.
 *
 * Thematic baskets share constituents, so someone holding three of them is
 * usually far more concentrated than they believe. `weightByStrategy` is the
 * share of the user's total capital in each strategy.
 */
export function combinedExposure(
  holdings: readonly { readonly weights: readonly Weight[]; readonly shareOfCapital: number }[],
): Weight[] {
  const combined = new Map<string, number>();
  for (const holding of holdings) {
    for (const { symbol, weight } of holding.weights) {
      combined.set(symbol, (combined.get(symbol) ?? 0) + weight * holding.shareOfCapital);
    }
  }
  return [...combined.entries()]
    .map(([symbol, weight]) => ({ symbol, weight }))
    .sort((a, b) => b.weight - a.weight);
}
