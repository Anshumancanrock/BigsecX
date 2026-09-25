import { useId } from "react";

export const TIER = ["gold", "silver", "bronze"] as const;

export const PLACE = ["1st", "2nd", "3rd"] as const;

export type Tier = (typeof TIER)[number];

/** The metal for a rank, or null past third. */
export function tierOf(rank: number): Tier | null {
  return TIER[rank - 1] ?? null;
}

/** Light, body, shade and edge for each metal. */
const METAL: Readonly<Record<Tier, readonly [string, string, string, string]>> = {
  gold: ["#FFF3C4", "#F7C744", "#C98A16", "#8A5A0A"],
  silver: ["#FFFFFF", "#D5DCE5", "#8F9BAA", "#586371"],
  bronze: ["#FFE2C8", "#E3935A", "#A55A2B", "#6B3717"],
};

/** A trophy in the metal of its place, drawn in SVG so it renders the same at every size. */
export function Trophy({ rank, size = 44 }: { rank: 1 | 2 | 3; size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const tier = TIER[rank - 1]!;
  const [light, body, shade, edge] = METAL[tier];
  return (
    <svg
      className={`trophy ${tier}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={`${PLACE[rank - 1]} place trophy`}
    >
      <defs>
        <linearGradient id={`${id}m`} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="0.42" stopColor={body} />
          <stop offset="1" stopColor={shade} />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={body} />
          <stop offset="1" stopColor={shade} />
        </linearGradient>
      </defs>
      {/* A soft shadow under the base. */}
      <ellipse cx="32" cy="59" rx="17" ry="2.6" fill="#000" opacity="0.12" />
      {/* Handles. */}
      <path
        d="M18.5 14H12.2a2.2 2.2 0 0 0-2.2 2.4c.5 6 4.3 10.6 9.9 11.8M45.5 14h6.3a2.2 2.2 0 0 1 2.2 2.4c-.5 6-4.3 10.6-9.9 11.8"
        fill="none"
        stroke={`url(#${id}b)`}
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      {/* The cup. */}
      <path d="M17 8.5h30V20c0 9.8-6.7 17.5-15 17.5S17 29.8 17 20V8.5Z" fill={`url(#${id}m)`} />
      <rect x="15.5" y="6.5" width="33" height="4.4" rx="2.2" fill={light} />
      <rect x="15.5" y="6.5" width="33" height="4.4" rx="2.2" fill={body} opacity="0.35" />
      {/* Light on the metal. */}
      <path
        d="M22.4 13.5c.2 7.4 2.3 12.6 6.4 16.4"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.6"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* Neck and base. */}
      <path d="M28 37h8l-1.2 6.5h-5.6L28 37Z" fill={`url(#${id}b)`} />
      <path d="M22.5 43h19a2.5 2.5 0 0 1 2.5 2.5V48h-24v-2.5a2.5 2.5 0 0 1 2.5-2.5Z" fill={`url(#${id}b)`} />
      <rect x="16" y="47.5" width="32" height="9" rx="2.4" fill={`url(#${id}m)`} />
      <rect x="21" y="50" width="22" height="4" rx="1.2" fill={edge} opacity="0.22" />
      {/* The place, stamped on the cup, where it is large enough to read. */}
      {size >= 30 ? (
      <text
        x="32"
        y="25.5"
        textAnchor="middle"
        fontSize="13"
        fontWeight="800"
        fontFamily="system-ui, sans-serif"
        fill={edge}
        opacity="0.9"
      >
        {rank}
      </text>
      ) : null}
    </svg>
  );
}

/** The place, as a small figure: a trophy for the top three, the number after. */
export function Medal({ rank, size = 24 }: { rank: number; size?: number }) {
  if (rank === 1 || rank === 2 || rank === 3) {
    return (
      <span className="medal-trophy" style={{ width: size, height: size }}>
        <Trophy rank={rank} size={Math.round(size * 1.3)} />
      </span>
    );
  }
  return (
    <span className="medal" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }} aria-label={`Rank ${rank}`}>
      {rank}
    </span>
  );
}

export function TrophyIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path
        d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3.5M8.5 20.5h7M10 17.5h4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
