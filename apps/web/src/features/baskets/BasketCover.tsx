type Weight = { readonly symbol: string; readonly weight: number };

export const COVERS = ["pre8", "frontier-ai", "embodied", "defense-space", "prediction", "value", "liquid"] as const;
type Cover = (typeof COVERS)[number];

const FOCUS: Readonly<Partial<Record<Cover, string>>> = {
  embodied: "50% 0%",
  "defense-space": "50% 72%",
  prediction: "50% 40%",
};

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
