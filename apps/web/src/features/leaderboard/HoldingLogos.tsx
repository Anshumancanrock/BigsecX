import type { LeaderboardEntry } from "../../lib/api.ts";
import { TokenLogo } from "../../components/TokenLogo.tsx";
import { useCompanyName } from "../../lib/market.ts";

/** What a trader holds now, by symbol: live when read, else as reconstructed. */
export function holdingsOf(entry: LeaderboardEntry): string[] {
  return [...(entry.held ?? entry.positions.filter((p) => p.uiAmount > 0).map((p) => p.symbol))];
}

/** Up to four logos, overlapping, then "+2"; or a word when there are none. */
export function HoldingLogos({ symbols, size = 18, label = true }: { symbols: readonly string[]; size?: number; label?: boolean }) {
  const nameOf = useCompanyName();
  if (symbols.length === 0) return <span className="holding-logos none">Holds nothing</span>;
  const shown = symbols.slice(0, 4);
  return (
    <span className="holding-logos" title={symbols.map(nameOf).join(", ")}>
      <span className="holding-logos-stack" aria-hidden="true">
        {shown.map((symbol) => (
          <TokenLogo key={symbol} symbol={symbol} size={size} badge={false} />
        ))}
      </span>
      {label ? (
        <span className="holding-logos-words">
          {symbols.length === 1 ? nameOf(symbols[0]!) : `${symbols.length} companies`}
        </span>
      ) : symbols.length > shown.length ? (
        <span className="holding-logos-words">+{symbols.length - shown.length}</span>
      ) : null}
    </span>
  );
}
