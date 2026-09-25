/**
 * A basket's cover photo. The photos are from Unsplash (credits in
 * public/covers/CREDITS.md), cropped to 2:1 and served from this site at two
 * widths. A user-built basket uses the cover of its largest holding.
 */

type Weight = { readonly symbol: string; readonly weight: number };

/** The ready-made baskets that have a photograph, by id. */
export const COVERS = ["pre8", "frontier-ai", "embodied", "defense-space", "prediction", "value", "liquid"] as const;
type Cover = (typeof COVERS)[number];

/** Focal point per photo, for crops wider than the 2:1 files (cards are 16:7). */
const FOCUS: Readonly<Partial<Record<Cover, string>>> = {
  embodied: "50% 0%",
  "defense-space": "50% 72%",
  prediction: "50% 40%",
};

/** Which photograph stands for each company, for baskets people build. */
const COVER_BY_COMPANY: Readonly<Record<string, Cover>> = {
  OPENAI: "frontier-ai",
  ANTHROPIC: "frontier-ai",
  SPACEX: "defense-space",
  ANDURIL: "defense-space",
  NEURALINK: "embodied",
  FIGUREAI: "embodied",
  KALSHI: "prediction",
  POLYMARKET: "prediction",
};

/** The photograph for a basket: its own, or its heaviest company's. */
export function coverFor(id: string, weights: readonly Weight[] | null | undefined): Cover {
  if ((COVERS as readonly string[]).includes(id)) return id as Cover;
  const heaviest = [...(weights ?? [])].sort((a, b) => b.weight - a.weight)[0];
  return (heaviest && COVER_BY_COMPANY[heaviest.symbol]) ?? "pre8";
}

export function BasketCover({
  id,
  weights,
  className = "",
  eager = false,
}: {
  id: string;
  weights: readonly Weight[] | null | undefined;
  className?: string;
  /** Load at once rather than when scrolled near: for a cover at the top of its page. */
  eager?: boolean;
}) {
  const cover = coverFor(id, weights);
  return (
    <span className={`basket-cover ${className}`}>
      {/* Decorative: the card names the basket in text right below it. */}
      <img
        src={`/covers/${cover}-720.webp`}
        srcSet={`/covers/${cover}-720.webp 720w, /covers/${cover}-1200.webp 1200w`}
        sizes="(max-width: 720px) 100vw, 440px"
        width={720}
        height={360}
        alt=""
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        style={FOCUS[cover] ? { objectPosition: FOCUS[cover] } : undefined}
      />
    </span>
  );
}
