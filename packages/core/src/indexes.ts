/**
 * Thematic indexes: portfolios whose weights a rule produces.
 *
 * Definitions are data, not code, so an index can be added without touching
 * the weighting engine and so the exact rule that produced a historical
 * allocation can be stored and replayed.
 *
 * On the choice of themes: the tradable universe is eight private companies,
 * which does not support every theme one might want. There is no nuclear name
 * here, and no amount of index design creates one -- a "nuclear index" over
 * this universe would be a label over unrelated holdings. The themes below are
 * the ones the universe actually supports.
 */

import { capWeights, normalizeWeights, type Portfolio, type Weight } from "./portfolio.ts";
import type { Sector } from "./universe.ts";

/** How constituent weights are derived. */
export type WeightingScheme =
  /** Every constituent gets the same weight. Robust when depth is uneven. */
  | { readonly kind: "equal" }
  /** Weighted by the issuer's implied company valuation. */
  | { readonly kind: "valuation"; readonly maxWeight: number }
  /**
   * Weighted by quotable DEX depth. Unfashionable as an index rule, but it is
   * the weighting a basket can actually be filled at in this market.
   */
  | { readonly kind: "liquidity"; readonly maxWeight: number }
  /**
   * Valuation weighted, then tilted toward names trading below their mark.
   * `tilt` is the extra weight multiple applied at a 100% discount.
   */
  | { readonly kind: "basis-tilt"; readonly maxWeight: number; readonly tilt: number };

export interface IndexDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Include a token if it carries any of these sectors. */
  readonly sectors?: readonly Sector[];
  /** Or pin an explicit constituent list. Takes precedence over `sectors`. */
  readonly symbols?: readonly string[];
  readonly scheme: WeightingScheme;
  /**
   * Exclude constituents with less quotable depth than this. Keeps an index
   * from carrying a position no user can actually buy.
   */
  readonly minLiquidityUsd?: number;
}

/** Per-token inputs the weighting rules read. */
export interface IndexInput {
  readonly symbol: string;
  readonly sectors: readonly Sector[];
  readonly impliedValuationUsd: number | null;
  readonly liquidityUsd: number;
  /** Market over mark, as a fraction. Null when no mark is published. */
  readonly basis: number | null;
}

export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  {
    id: "pre8",
    name: "PreStocks 8",
    description:
      "The whole tradable pre-IPO universe, weighted by implied valuation and capped so no single company dominates.",
    scheme: { kind: "valuation", maxWeight: 0.25 },
  },
  {
    id: "frontier-ai",
    name: "Frontier AI Labs",
    description: "The companies training frontier models.",
    sectors: ["ai-lab"],
    scheme: { kind: "valuation", maxWeight: 0.4 },
  },
  {
    id: "embodied",
    name: "Embodied AI",
    description: "Humanoid robotics and brain-computer interfaces: AI that acts on the physical world.",
    sectors: ["robotics", "neurotech"],
    scheme: { kind: "equal" },
  },
  {
    id: "defense-space",
    name: "Defense & Space",
    description: "Launch capability and autonomous defense systems.",
    sectors: ["space", "defense"],
    scheme: { kind: "valuation", maxWeight: 0.6 },
  },
  {
    id: "prediction",
    name: "Prediction Markets",
    description: "The two venues turning real-world outcomes into tradable contracts.",
    sectors: ["prediction-market"],
    scheme: { kind: "equal" },
  },
  {
    id: "value",
    name: "Below Mark",
    description:
      "Tilted toward companies whose tokens trade under the issuer's mark. There is no retail redemption path, so these gaps persist rather than arbitrage away.",
    scheme: { kind: "basis-tilt", maxWeight: 0.35, tilt: 1.5 },
    minLiquidityUsd: 50_000,
  },
  {
    id: "liquid",
    name: "Deep Liquidity",
    description:
      "Weighted by quotable depth. The basket that rebalances with the least price impact, which in a $2.6M market is a real constraint.",
    scheme: { kind: "liquidity", maxWeight: 0.35 },
    minLiquidityUsd: 100_000,
  },
];

function selectConstituents(
  definition: IndexDefinition,
  inputs: readonly IndexInput[],
): readonly IndexInput[] {
  let selected = definition.symbols
    ? inputs.filter((i) => definition.symbols?.includes(i.symbol))
    : definition.sectors
      ? inputs.filter((i) => i.sectors.some((s) => definition.sectors?.includes(s)))
      : inputs;

  if (definition.minLiquidityUsd !== undefined) {
    const liquid = selected.filter((i) => i.liquidityUsd >= (definition.minLiquidityUsd ?? 0));
    // Never let a liquidity floor empty an index; report the unfiltered set
    // instead so the caller can show why it looks different than expected.
    if (liquid.length > 0) selected = liquid;
  }
  return selected;
}

function rawWeights(scheme: WeightingScheme, inputs: readonly IndexInput[]): Weight[] {
  switch (scheme.kind) {
    case "equal":
      return inputs.map((i) => ({ symbol: i.symbol, weight: 1 }));

    case "valuation":
      return inputs.map((i) => ({ symbol: i.symbol, weight: i.impliedValuationUsd ?? 0 }));

    case "liquidity":
      return inputs.map((i) => ({ symbol: i.symbol, weight: i.liquidityUsd }));

    case "basis-tilt":
      return inputs.map((i) => {
        const base = i.impliedValuationUsd ?? 0;
        // A discount (negative basis) raises the multiplier above 1; a premium
        // lowers it. Floored so a very rich name is underweighted, not negative.
        const multiplier = Math.max(0.1, 1 - (i.basis ?? 0) * scheme.tilt);
        return { symbol: i.symbol, weight: base * multiplier };
      });
  }
}

/**
 * Build an index's target weights from live market inputs.
 *
 * Returns null when the definition selects nothing tradable, which is a real
 * state -- a liquidity floor can empty a narrow theme -- and the caller should
 * show it rather than render an empty basket as a valid one.
 */
export function buildIndex(
  definition: IndexDefinition,
  inputs: readonly IndexInput[],
): Portfolio | null {
  const constituents = selectConstituents(definition, inputs);
  if (constituents.length === 0) return null;

  const raw = rawWeights(definition.scheme, constituents).filter((w) => w.weight > 0);
  if (raw.length === 0) return null;

  const scheme = definition.scheme;
  const weights =
    scheme.kind === "equal"
      ? normalizeWeights(raw)
      : capWeights(raw, Math.max(scheme.maxWeight, 1 / raw.length));

  return {
    id: definition.id,
    name: definition.name,
    kind: "index",
    weights,
  };
}

export function definitionById(id: string): IndexDefinition | undefined {
  return INDEX_DEFINITIONS.find((d) => d.id === id);
}
