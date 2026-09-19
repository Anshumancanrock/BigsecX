/**
 * The PreStocks universe and the thematic groupings we build indexes from.
 *
 * Mints are pinned here rather than discovered purely from the issuer API for
 * two reasons: the API is rate limited and occasionally returns a null price
 * field, and a trading app should never route to a mint it has not seen before
 * without a human adding it. `syncUniverse` reconciles this list against the
 * live API and reports drift instead of silently trusting either side.
 */

/** A company theme. Indexes are built by selecting on these. */
export type Sector =
  | "ai-lab"
  | "robotics"
  | "space"
  | "defense"
  | "prediction-market"
  | "neurotech";

export interface PreStock {
  readonly symbol: string;
  readonly name: string;
  /** Token-2022 mint address. */
  readonly mint: string;
  readonly decimals: number;
  readonly sectors: readonly Sector[];
}

/** Token-2022 program. PreStocks mints are not owned by the legacy program. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/**
 * Every authority on these mints is the same key. It can freeze accounts, pause
 * all transfers, claw back balances via the permanent delegate, and rewrite the
 * transfer fee. Users must be told this; it is a property of the asset, not of
 * our app, and no amount of non-custodial design removes it.
 */
export const PRESTOCKS_AUTHORITY = "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc";

export const UNIVERSE: readonly PreStock[] = [
  {
    symbol: "OPENAI",
    name: "OpenAI",
    mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
    decimals: 9,
    sectors: ["ai-lab"],
  },
  {
    symbol: "ANTHROPIC",
    name: "Anthropic",
    mint: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
    decimals: 9,
    sectors: ["ai-lab"],
  },
  {
    symbol: "SPACEX",
    name: "SpaceX",
    mint: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh",
    decimals: 9,
    sectors: ["space", "defense"],
  },
  {
    symbol: "ANDURIL",
    name: "Anduril",
    mint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB",
    decimals: 9,
    sectors: ["defense", "ai-lab"],
  },
  {
    symbol: "NEURALINK",
    name: "Neuralink",
    mint: "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S",
    decimals: 9,
    sectors: ["neurotech"],
  },
  {
    symbol: "FIGUREAI",
    name: "Figure AI",
    mint: "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd",
    decimals: 9,
    sectors: ["robotics", "ai-lab"],
  },
  {
    symbol: "KALSHI",
    name: "Kalshi",
    mint: "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua",
    decimals: 9,
    sectors: ["prediction-market"],
  },
  {
    symbol: "POLYMARKET",
    name: "Polymarket",
    mint: "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP",
    decimals: 9,
    sectors: ["prediction-market"],
  },
];

const BY_MINT = new Map(UNIVERSE.map((t) => [t.mint, t]));
const BY_SYMBOL = new Map(UNIVERSE.map((t) => [t.symbol, t]));

export function bySymbol(symbol: string): PreStock | undefined {
  return BY_SYMBOL.get(symbol.toUpperCase());
}

export function byMint(mint: string): PreStock | undefined {
  return BY_MINT.get(mint);
}

export function inSector(sector: Sector): readonly PreStock[] {
  return UNIVERSE.filter((t) => t.sectors.includes(sector));
}

export const ALL_MINTS: readonly string[] = UNIVERSE.map((t) => t.mint);

/**
 * Compare the pinned universe against what the issuer currently lists.
 *
 * A new listing is an opportunity, a delisting is a risk, and either one should
 * reach a human rather than change routing behaviour on its own.
 */
export function diffUniverse(
  liveMints: readonly { readonly symbol: string; readonly mint: string }[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const live = new Set(liveMints.map((t) => t.mint));
  return {
    added: liveMints.filter((t) => !BY_MINT.has(t.mint)).map((t) => t.symbol),
    removed: UNIVERSE.filter((t) => !live.has(t.mint)).map((t) => t.symbol),
  };
}
