/**
 * Thematic indexes: portfolios whose weights a rule produces. Definitions are
 * data, so an index can be added without touching the weighting engine and the
 * rule behind a historical allocation can be stored and replayed. Themes are
 * limited to what the eight-company universe actually supports.
 */

import { capWeights, normalizeWeights, type Portfolio, type Weight } from "./portfolio.ts";
import type { Sector } from "./universe.ts";

export type WeightingScheme =
  | { readonly kind: "equal" }
  /** Weighted by the issuer's implied company valuation. */
  | { readonly kind: "valuation"; readonly maxWeight: number }
  /**
   * Weighted by quotable DEX depth, the weighting a basket can actually be
   * filled at in this market.
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
  readonly sectors?: readonly Sector[];
  readonly symbols?: readonly string[];
  readonly scheme: WeightingScheme;
  readonly minLiquidityUsd?: number;
}

export interface IndexInput {
  readonly symbol: string;
  readonly sectors: readonly Sector[];
  readonly impliedValuationUsd: number | null;
  readonly liquidityUsd: number;
  readonly basis: number | null;
  /**
   * True when the issuer has halted transfers on this mint. Every swap
   * touching it fails, so it is excluded before weighting.
   */
  readonly paused?: boolean;
}

export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  {
    id: "pre8",
    name: "Everything",
    description:
      "A slice of every private company here, with the biggest ones weighted heaviest and no single one allowed to dominate.",
    scheme: { kind: "valuation", maxWeight: 0.25 },
  },
  {
    id: "frontier-ai",
    name: "The AI labs",
    description: "The labs building the frontier AI models — OpenAI and Anthropic among them.",
    sectors: ["ai-lab"],
    scheme: { kind: "valuation", maxWeight: 0.4 },
  },
  {
    id: "embodied",
    name: "Robots and brains",
    description: "AI that moves in the real world: humanoid robots and brain-computer interfaces.",
    sectors: ["robotics", "neurotech"],
    scheme: { kind: "equal" },
  },
  {
    id: "defense-space",
    name: "Space and defence",
    description: "Rockets and autonomous defence — the companies building hardware that flies.",
    sectors: ["space", "defense"],
    scheme: { kind: "valuation", maxWeight: 0.6 },
  },
  {
    id: "prediction",
    name: "Prediction markets",
    description: "The two venues that turn real-world events into something you can trade.",
    sectors: ["prediction-market"],
    scheme: { kind: "equal" },
  },
  {
    id: "value",
    name: "Looks cheap",
    description:
      "Weighted toward whatever is currently trading below the price its issuer publishes.",
    scheme: { kind: "basis-tilt", maxWeight: 0.35, tilt: 1.5 },
    minLiquidityUsd: 50_000,
  },
  {
    id: "liquid",
    name: "Easiest to sell",
    description:
      "Weighted toward the companies with the busiest markets, so it is the easiest one to get out of.",
    scheme: { kind: "liquidity", maxWeight: 0.35 },
    minLiquidityUsd: 100_000,
  },
];

function selectConstituents(
  definition: IndexDefinition,
  inputs: readonly IndexInput[],
): readonly IndexInput[] {
  inputs = inputs.filter((i) => i.paused !== true);

  let selected = definition.symbols
    ? inputs.filter((i) => definition.symbols?.includes(i.symbol))
    : definition.sectors
      ? inputs.filter((i) => i.sectors.some((s) => definition.sectors?.includes(s)))
      : inputs;

  if (definition.minLiquidityUsd !== undefined) {
    const liquid = selected.filter((i) => i.liquidityUsd >= (definition.minLiquidityUsd ?? 0));
    // A liquidity floor never empties an index; the unfiltered set stays.
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
