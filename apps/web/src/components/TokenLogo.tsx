/**
 * A company logo with a Solana badge. Falls back to the two-letter mark while
 * the directory URL is missing or the image fails to load.
 */

import { useId, useState } from "react";
import { markOf } from "../lib/format.ts";
import { useMarket } from "../lib/market.ts";

export function TokenLogo({ symbol, size = 40, badge = true }: { symbol: string; size?: number; badge?: boolean }) {
  const token = useMarket()?.tokens.find((t) => t.symbol === symbol);
  const [failed, setFailed] = useState<string | null>(null);
  const src = token?.iconUrl && failed !== token.iconUrl ? token.iconUrl : null;

  return (
    <span className="token-logo" style={{ width: size, height: size }} aria-hidden="true">
      {/* The mark sits underneath, so a logo still loading shows the
          company's letters rather than an empty circle. */}
      <span className="token-logo-mark" style={{ fontSize: Math.round(size * 0.34) }}>
        {markOf(symbol)}
      </span>
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
        />
      ) : null}
      {badge ? <SolanaBadge size={Math.max(12, Math.round(size * 0.38))} /> : null}
    </span>
  );
}

/** The Solana mark: three slanted bars in its purple-to-green gradient. */
export function SolanaBadge({ size = 14 }: { size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="solana-badge" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={`sol-${id}`} x1="5" y1="18" x2="19" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="11.5" fill="#0b0d10" stroke="hsl(0 0% 100% / 0.18)" />
      <g fill={`url(#sol-${id})`}>
        <path d="M8.4 6.6h9.4l-2.2 2.3H6.2z" />
        <path d="M6.2 10.85h9.4l2.2 2.3H8.4z" />
        <path d="M8.4 15.1h9.4l-2.2 2.3H6.2z" />
      </g>
    </svg>
  );
}
