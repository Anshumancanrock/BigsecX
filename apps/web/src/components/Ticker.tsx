import { useEffect, useRef, useState } from "react";
import type { MarketToken } from "../lib/api.ts";
import { price } from "../lib/format.ts";
import { popDigits, type Digit } from "../lib/digits.ts";
import { go } from "../lib/router.ts";
import { TokenLogo } from "./TokenLogo.tsx";
import { reducedMotion } from "../lib/motion.ts";

export function Ticking({
  value,
  format = price,
  className = "",
}: {
  value: number | null;
  format?: (value: number | null) => string;
  className?: string;
}) {
  const text = format(value);
  const digits = useRef<Digit[] | null>(null);
  const nextKey = useRef(0);
  const last = useRef<number | null>(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  const first = digits.current === null;
  const { digits: now, nextKey: key } = popDigits(digits.current, text, nextKey.current);
  digits.current = now;
  nextKey.current = key;

  useEffect(() => {
    const before = last.current;
    last.current = value;
    if (before === null || value === null || before === value || reducedMotion()) return;
    setFlash(value > before ? "up" : "down");
    const id = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(id);
  }, [value]);

  return (
    <span className={`ticking${flash ? ` flash-${flash}` : ""} ${className}`}>
      {now.map((d) => (
        <span
          key={d.key}
          className={first || d.stagger === null ? "tick-digit" : "tick-digit roll"}
          style={d.stagger === null || first ? undefined : ({ "--i": d.stagger } as React.CSSProperties)}
        >
          {d.char}
        </span>
      ))}
    </span>
  );
}

export function TickerTape({ tokens }: { tokens: readonly MarketToken[] }) {
  if (tokens.length === 0) return null;
  const row = (copy: number) =>
    tokens.map((t) => {
      const move = t.change24hPct;
      const page = `/companies/${t.symbol.toLowerCase()}`;
      return (
        <a
          key={`${copy}-${t.symbol}`}
          className="tape-item"
          href={page}
          onClick={go(page)}
          tabIndex={copy === 0 ? 0 : -1}
          aria-hidden={copy === 0 ? undefined : true}
        >
          <TokenLogo symbol={t.symbol} size={22} badge={false} />
          <b>{t.name}</b>
          <span className="num">{price(t.marketUsd)}</span>
          <span className={`num ${move == null ? "muted" : move >= 0 ? "up" : "down"}`}>
            {move == null ? "—" : `${move >= 0 ? "▲" : "▼"} ${Math.abs(move).toFixed(2)}%`}
          </span>
        </a>
      );
    });
  return (
    <div className="tape" aria-label="Live prices">
      <div className="tape-track">
        {row(0)}
        {row(1)}
      </div>
    </div>
  );
}
