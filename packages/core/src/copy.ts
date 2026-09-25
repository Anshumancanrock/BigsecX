/**
 * Copy trading mirrors a leader's weights, not their trades, so a copy is
 * proportional at any account size and a late follower gets the current
 * allocation. A preview only yields target weights and the follower signs
 * every transaction, so stopping a copy needs no on-chain action.
 */

import { capWeights, normalizeWeights, type Weight } from "./portfolio.ts";
import { bySymbol } from "./universe.ts";

export interface CopyLimits {
  /** Capital the follower is willing to commit, in USD. */
  readonly capitalUsd: number;
  /** Fraction of capital to deploy, in (0, 1]; the rest stays in stablecoin. */
  readonly copyRatio: number;
  /** No copied position may exceed this share of deployed capital. */
  readonly maxPositionWeight: number;
  readonly maxSlippageBps: number;
  /** Symbols the follower refuses to hold regardless of the leader. */
  readonly excludeSymbols?: readonly string[];
  /**
   * Stop copying once the follower is down this fraction from their peak.
   * Enforced by the caller against observed value.
   */
  readonly stopLossFraction?: number;
}

/**
 * Defaults that copy faithfully. There is no position cap by default, since a
 * default cap would silently give the follower a different allocation.
 */
export const DEFAULT_COPY_LIMITS: Omit<CopyLimits, "capitalUsd"> = {
  copyRatio: 1,
  maxPositionWeight: 1,
  maxSlippageBps: 150,
};

export class CopyLimitsInvalid extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("; "));
    this.name = "CopyLimitsInvalid";
  }
}

/** Largest copy this market can absorb, given ~$2.6M of total depth. */
const MAX_CAPITAL_USD = 1_000_000;

export function validateCopyLimits(limits: CopyLimits): void {
  const problems: string[] = [];

  if (!Number.isFinite(limits.capitalUsd) || limits.capitalUsd <= 0) {
    problems.push("capitalUsd must be a positive finite number");
  } else if (limits.capitalUsd > MAX_CAPITAL_USD) {
    problems.push(`capitalUsd must be at most ${MAX_CAPITAL_USD}`);
  }
  if (!Number.isFinite(limits.copyRatio) || limits.copyRatio <= 0 || limits.copyRatio > 1) {
    problems.push("copyRatio must be between 0 and 1");
  }
  if (
    !Number.isFinite(limits.maxPositionWeight) ||
    limits.maxPositionWeight <= 0 ||
    limits.maxPositionWeight > 1
  ) {
    problems.push("maxPositionWeight must be between 0 and 1");
  }
  if (
    !Number.isFinite(limits.maxSlippageBps) ||
    limits.maxSlippageBps < 1 ||
    limits.maxSlippageBps > 5_000
  ) {
    problems.push("maxSlippageBps must be between 1 and 5000");
  }
  if (limits.stopLossFraction !== undefined) {
    if (
      !Number.isFinite(limits.stopLossFraction) ||
      limits.stopLossFraction <= 0 ||
      limits.stopLossFraction >= 1
    ) {
      problems.push("stopLossFraction must be between 0 and 1");
    }
  }
  for (const symbol of limits.excludeSymbols ?? []) {
    if (!bySymbol(symbol)) problems.push(`unknown excluded symbol ${JSON.stringify(symbol)}`);
  }

  if (problems.length > 0) throw new CopyLimitsInvalid(problems);
}

export interface CopyPreview {
  readonly leader: string;
  /** Capital actually deployed, after the copy ratio. */
  readonly deployUsd: number;
  /** Capital deliberately held back in stablecoin. */
  readonly reserveUsd: number;
  readonly targetWeights: readonly Weight[];
  readonly positions: readonly { readonly symbol: string; readonly weight: number; readonly usd: number }[];
  /** Symbols dropped, with the reason, so nothing disappears silently. */
  readonly excluded: readonly { readonly symbol: string; readonly weight: number; readonly reason: string }[];
  readonly notes: readonly string[];
}

/**
 * What a follower would hold if they started copying now.
 *
 * Exclusions are removed and the rest renormalised, so a refused name is
 * redistributed rather than left as cash; the position cap applies after that.
 */
export function previewCopy(args: {
  readonly leader: string;
  readonly leaderWeights: readonly Weight[];
  readonly limits: CopyLimits;
  /** Symbols the issuer has halted; they cannot be bought at any size. */
  readonly pausedSymbols?: readonly string[];
}): CopyPreview {
  validateCopyLimits(args.limits);

  const excluded: { symbol: string; weight: number; reason: string }[] = [];
  const notes: string[] = [];

  const refused = new Set((args.limits.excludeSymbols ?? []).map((s) => s.toUpperCase()));
  const paused = new Set((args.pausedSymbols ?? []).map((s) => s.toUpperCase()));

  const kept: Weight[] = [];
  for (const entry of args.leaderWeights) {
    const symbol = entry.symbol.toUpperCase();
    if (entry.weight <= 0) continue;

    if (refused.has(symbol)) {
      excluded.push({ symbol, weight: entry.weight, reason: "excluded by the follower" });
      continue;
    }
    if (paused.has(symbol)) {
      excluded.push({ symbol, weight: entry.weight, reason: "transfers halted by the issuer" });
      continue;
    }
    if (!bySymbol(symbol)) {
      excluded.push({ symbol, weight: entry.weight, reason: "not a tradable symbol" });
      continue;
    }
    kept.push({ symbol, weight: entry.weight });
  }

  const deployUsd = args.limits.capitalUsd * args.limits.copyRatio;
  const reserveUsd = args.limits.capitalUsd - deployUsd;

  if (kept.length === 0) {
    notes.push("Nothing of this leader's portfolio can be copied under these limits.");
    return {
      leader: args.leader,
      deployUsd: 0,
      reserveUsd: args.limits.capitalUsd,
      targetWeights: [],
      positions: [],
      excluded,
      notes,
    };
  }

  if (excluded.length > 0) {
    notes.push(
      `${excluded.length} of the leader's positions were dropped; the remainder was rescaled to fill the gap.`,
    );
  }

  // A cap below an equal split cannot be met; widen it to 1/n and say so
  // rather than fail a preview the follower can still act on.
  const feasibleCap = Math.max(args.limits.maxPositionWeight, 1 / kept.length);
  if (feasibleCap > args.limits.maxPositionWeight + 1e-12) {
    notes.push(
      `The ${(args.limits.maxPositionWeight * 100).toFixed(0)}% position cap cannot be met with ` +
        `${kept.length} positions; ${(feasibleCap * 100).toFixed(1)}% is the tightest possible.`,
    );
  }
  const uncapped = normalizeWeights(kept);
  const targetWeights = capWeights(uncapped, feasibleCap);

  // Name the positions the cap moved, so the follower sees where the copy
  // differs from the leader.
  const capped = uncapped
    .filter((w) => {
      const after = targetWeights.find((t) => t.symbol === w.symbol)?.weight ?? w.weight;
      return w.weight - after > 1e-9;
    })
    .map((w) => w.symbol);
  if (capped.length > 0) {
    notes.push(
      `The position cap reduced ${capped.join(", ")}; this allocation differs from the leader's.`,
    );
  }

  if (reserveUsd > 0) {
    notes.push(
      `${((1 - args.limits.copyRatio) * 100).toFixed(0)}% of capital is held in stablecoin by the copy ratio.`,
    );
  }

  return {
    leader: args.leader,
    deployUsd,
    reserveUsd,
    targetWeights,
    positions: targetWeights.map((w) => ({
      symbol: w.symbol,
      weight: w.weight,
      usd: w.weight * deployUsd,
    })),
    excluded,
    notes,
  };
}

/**
 * Whether a follower's stop-loss has been reached, measured as drawdown from
 * the observed peak rather than from the starting value.
 */
export function stopLossTriggered(args: {
  readonly peakValueUsd: number;
  readonly currentValueUsd: number;
  readonly stopLossFraction: number | undefined;
}): { readonly triggered: boolean; readonly drawdownFraction: number } {
  if (args.peakValueUsd <= 0) return { triggered: false, drawdownFraction: 0 };
  const drawdownFraction = Math.max(0, 1 - args.currentValueUsd / args.peakValueUsd);
  return {
    triggered:
      args.stopLossFraction !== undefined && drawdownFraction >= args.stopLossFraction,
    drawdownFraction,
  };
}
