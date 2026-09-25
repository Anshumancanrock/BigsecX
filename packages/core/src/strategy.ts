/**
 * Strategies: portfolios somebody authored and can publish, and the rules one
 * must satisfy before it is saved. Validation lives here rather than at the API
 * edge because the indexer builds strategies too.
 */

import { capWeights, normalizeWeights, type Portfolio, type Weight } from "./portfolio.ts";
import { UNIVERSE, bySymbol, type Sector } from "./universe.ts";

export type RebalanceFrequency = "manual" | "daily" | "weekly" | "monthly";

/**
 * Limits a strategy promises to keep, stored with it and checked on every
 * rebalance rather than only at creation.
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

/**
 * Defaults that constrain nothing about the allocation: a default cap would
 * silently reshape a basket (a 60/40 pair under a 40% cap becomes 50/50).
 * `driftBps` has a real default because it sets when to rebalance, not what
 * to hold.
 */
export const DEFAULT_GUARDRAILS: Guardrails = {
  maxWeight: 1,
  minWeight: 0,
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
  /**
   * Narrower than Portfolio's kind: a trader's live holdings are a portfolio
   * but not an authored strategy.
   */
  readonly kind: "index" | "user";
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
 * Fill in guardrails the author did not set. An explicit cap is enforced
 * exactly, never widened to make a basket fit; an infeasible one is reported.
 */
function resolveGuardrails(partial: Partial<Guardrails> | undefined): Guardrails {
  return {
    maxWeight: partial?.maxWeight ?? DEFAULT_GUARDRAILS.maxWeight,
    minWeight: partial?.minWeight ?? DEFAULT_GUARDRAILS.minWeight,
    driftBps: partial?.driftBps ?? DEFAULT_GUARDRAILS.driftBps,
    ...(partial?.maxSectorWeight !== undefined ? { maxSectorWeight: partial.maxSectorWeight } : {}),
  };
}

/**
 * Check guardrails are valid and satisfiable before checking weights against
 * them, so an impossible cap or floor is reported as such.
 */
function guardrailProblems(rails: Guardrails, count: number): string[] {
  const problems: string[] = [];

  if (!(rails.maxWeight > 0 && rails.maxWeight <= 1)) {
    problems.push("maxWeight must be between 0 and 1");
  }
  if (!(rails.minWeight >= 0 && rails.minWeight <= 1)) {
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
 * Weights may be in any units (percentages, dollars, scores); they are
 * normalised, then capped. Throws `StrategyInvalid` listing every problem.
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

  const rails = resolveGuardrails(draft.guardrails);
  problems.push(...guardrailProblems(rails, seen.size));

  // Stop here when the inputs cannot be weighted at all; anything further
  // would report consequences of the problems already listed.
  if (problems.length > 0) throw new StrategyInvalid(problems);

  const normalized = normalizeWeights(
    constituents.map((c) => ({ symbol: c.symbol.toUpperCase(), weight: c.weight })),
  );
  const weights = capWeights(normalized, rails.maxWeight);

  // The floor rejects rather than corrects: raising a position to meet it
  // would change the allocation the author asked for.
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
 * Whether any holding has drifted more than `driftBps` from target. Drift is
 * absolute weight: 300 bps is three points of the portfolio, not 3% of the
 * position.
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
 * Combined exposure per symbol across the strategies a user holds, which often
 * share constituents. `shareOfCapital` is each strategy's share of the user's
 * capital.
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
