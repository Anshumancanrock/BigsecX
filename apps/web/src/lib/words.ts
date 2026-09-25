/**
 * User-facing wording for protocol concepts. Screens use plain words and keep
 * the exact figure one tap away.
 */

/** How a basket picks and weights what it holds. */
export const SCHEME_WORDS: Readonly<Record<string, string>> = {
  valuation: "Bigger companies get more",
  equal: "Split evenly",
  "basis-tilt": "More of what looks cheap",
  liquidity: "More of what's easiest to trade",
  manual: "Hand-picked",
};

export function schemeWords(scheme: string | undefined): string {
  if (!scheme) return "";
  return SCHEME_WORDS[scheme] ?? scheme.replace(/-/g, " ");
}

/**
 * The price gap in plain words. `basis` is (market - mark) / mark; positive
 * means the market trades above the issuer's mark.
 */
export function priceGapWords(basis: number | null): { label: string; tone: "up" | "down" | "muted" } {
  if (basis === null || !Number.isFinite(basis)) return { label: "No official price", tone: "muted" };
  const pct = Math.abs(basis * 100);
  if (pct < 2) return { label: "About what it's officially worth", tone: "muted" };
  // A discount is good for a buyer, so it reads green.
  if (basis < 0) return { label: `${pct.toFixed(0)}% below official price`, tone: "up" };
  return { label: `${pct.toFixed(0)}% above official price`, tone: "down" };
}

/** How easily a position can be got out of, without saying "depth". */
export function liquidityWords(usd: number): { label: string; tone: "up" | "down" | "muted" } {
  if (usd >= 500_000) return { label: "Easy to sell", tone: "up" };
  if (usd >= 150_000) return { label: "Usually easy to sell", tone: "muted" };
  return { label: "Harder to sell — thin market", tone: "down" };
}

/** A fee in basis points, as a percentage: "1%", "0.5%". */
export function feePercent(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

/** The one-line version of what a transfer fee costs a user. */
export function feeWords(bps: number): string {
  return `${feePercent(bps)} fee on every buy and sell`;
}

/**
 * A scheduled fee change in plain words: when, and to what. Null when none is
 * pending. The epoch is named because it is exact; a duration can only be
 * approximated from it.
 */
export function feeChangeWords(
  change: { readonly fromBps: number; readonly toBps: number; readonly atEpoch: number } | null | undefined,
  currentEpoch: number | null | undefined,
): string | null {
  if (!change) return null;
  const direction = change.toBps > change.fromBps ? "rises" : "falls";
  const when =
    currentEpoch != null && change.atEpoch - currentEpoch === 1
      ? "at the next epoch, within about two days"
      : `at epoch ${change.atEpoch}`;
  return `The issuer's fee ${direction} from ${feePercent(change.fromBps)} to ${feePercent(change.toBps)} ${when}.`;
}

/**
 * The issuer's on-chain powers over a token, described by their effect
 * rather than by field name (`permanentDelegate`, `freezeAuthority`).
 */
export interface IssuerPower {
  readonly title: string;
  readonly detail: string;
}

export function issuerPowers(control: {
  permanentDelegate: string | null;
  freezeAuthority: string | null;
  transferHookProgramId: string | null;
}, paused: boolean): IssuerPower[] {
  const powers: IssuerPower[] = [];
  if (control.permanentDelegate) {
    powers.push({
      title: "The issuer can move your tokens",
      detail:
        "This token lets its issuer transfer it out of any wallet without that owner's approval. " +
        "It is how they handle a real-world corporate action, and it is also a power you are trusting them not to misuse.",
    });
  }
  if (control.freezeAuthority) {
    powers.push({
      title: "The issuer can freeze your tokens",
      detail: "They can make any account unable to send, which means you could be unable to sell until they unfreeze it.",
    });
  }
  if (control.transferHookProgramId) {
    powers.push({
      title: "Transfers run extra issuer code",
      detail: "Every transfer calls a program the issuer controls, which can add conditions to moving the token.",
    });
  }
  if (paused) {
    powers.push({
      title: "Transfers are paused right now",
      detail: "Nobody can move this token at the moment, including you. Buying is not possible until it resumes.",
    });
  }
  return powers;
}

/** What this product is, for somebody who has never heard of it. */
export const WHAT_THIS_IS =
  "These are tokens that track private companies — SpaceX, OpenAI, Anthropic — the ones you normally " +
  "cannot invest in until they go public. You buy them with USDC, they land in your own wallet, and you " +
  "can sell them whenever the market has a buyer.";

/** Said once, before anyone spends anything. */
export const THE_HONEST_CAVEAT =
  "This is not stock. It is a token whose issuer says it tracks a company's value, and whose price is set " +
  "by a small market rather than by an exchange. Prices move, selling can be slow, and the issuer keeps " +
  "powers over the token that a share certificate would never give anyone.";

export const SECTOR_WORDS: Readonly<Record<string, string>> = {
  "ai-lab": "AI lab",
  robotics: "Robotics",
  space: "Space",
  defense: "Defence",
  "prediction-market": "Prediction market",
  neurotech: "Neurotech",
};
