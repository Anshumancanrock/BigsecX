/**
 * The feature cards' illustrations, drawn from live product data (depth, the
 * transfer fee, index weights) rather than static artwork.
 */

import type { Market, MarketToken } from "../lib/api.ts";
import { list, pct, price, usdCompact, weight } from "../lib/format.ts";

/** Depth ladder: how much each name can absorb before impact bites. */
export function DepthFigure({ market }: { market: Market | null }) {
  const tokens = [...(market?.tokens ?? [])]
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .slice(0, 5);
  const peak = Math.max(1, ...tokens.map((t) => t.liquidityUsd));

  return (
    <div className="fig fig-depth">
      {tokens.length === 0
        ? <FigSkeleton rows={5} />
        : tokens.map((t) => (
            <div className="fig-row" key={t.symbol}>
              <span className="fig-key">{t.symbol}</span>
              <span className="fig-bar">
                <i style={{ width: `${Math.max(6, (t.liquidityUsd / peak) * 100)}%` }} />
              </span>
              <span className="fig-val num">{usdCompact(t.liquidityUsd)}</span>
            </div>
          ))}
    </div>
  );
}

/**
 * The Token-2022 transfer fee and its epoch. The issuer sets it, it applies to
 * every transfer, and it can change at any epoch boundary.
 */
export function FeeFigure({ market }: { market: Market | null }) {
  const bps = list(market?.tokens)[0]?.transferFeeBps ?? null;
  const pending = market?.pendingFeeChange ?? null;

  return (
    <div className="fig fig-fee">
      <div className="fig-huge num">{bps == null ? "—" : `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`}</div>
      <div className="fig-unit">fee on every buy and sell</div>
      <div className="fig-note">
        {market ? "set by the issuer" : "loading"}
        {pending ? ` · rising to ${(pending.toBps / 100).toFixed(pending.toBps % 100 === 0 ? 0 : 1)}% at epoch ${pending.atEpoch}` : " · no change coming"}
      </div>
    </div>
  );
}

/** Custody: the app builds the transaction; the keys never leave the wallet. */
export function CustodyFigure() {
  return (
    <div className="fig fig-custody">
      <div className="custody-chain">
        <span className="custody-node">Your wallet</span>
        <span className="custody-link" aria-hidden="true" />
        <span className="custody-node ghost">BasketX builds</span>
        <span className="custody-link" aria-hidden="true" />
        <span className="custody-node">Your wallet</span>
      </div>
      <p className="fig-note">1 signature required · 0 held by us</p>
    </div>
  );
}

/** Basis: what the issuer says it's worth against what the book will pay. */
export function BasisFigure({ market }: { market: Market | null }) {
  const tokens = [...(market?.tokens ?? [])]
    .filter((t) => t.basis !== null)
    .sort((a, b) => Math.abs(b.basis!) - Math.abs(a.basis!))
    .slice(0, 4);

  return (
    <div className="fig fig-basis">
      {tokens.length === 0
        ? <FigSkeleton rows={4} />
        : tokens.map((t) => (
            <div className="fig-row" key={t.symbol}>
              <span className="fig-key">{t.symbol}</span>
              <span className="fig-val num">{price(t.markUsd)}</span>
              <span className={`fig-val num ${t.basis! >= 0 ? "up" : "down"}`}>{pct(t.basis! * 100)}</span>
            </div>
          ))}
      <p className="fig-note">official price vs. what the market pays</p>
    </div>
  );
}

/** 24h move across the universe, as a compact grid. */
export function MoversFigure({ market }: { market: Market | null }) {
  const tokens = [...(market?.tokens ?? [])]
    .filter((t) => t.change24hPct !== null)
    .sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))
    .slice(0, 6);

  return (
    <div className="fig fig-movers">
      {tokens.length === 0
        ? <FigSkeleton rows={3} />
        : tokens.map((t) => (
            <div className="mover" key={t.symbol}>
              <span className="fig-key">{t.symbol}</span>
              <span className={`num ${t.change24hPct! >= 0 ? "up" : "down"}`}>{pct(t.change24hPct)}</span>
            </div>
          ))}
    </div>
  );
}

/** Issuer powers that exist on every one of these mints. */
export function ControlFigure({ market }: { market: Market | null }) {
  const first: MarketToken | undefined = list(market?.tokens)[0];
  const rows = [
    ["Permanent delegate", first ? Boolean(first.issuerControl.permanentDelegate) : null],
    ["Freeze authority", first ? Boolean(first.issuerControl.freezeAuthority) : null],
    ["Transfer hook", first ? Boolean(first.issuerControl.transferHookProgramId) : null],
    ["Transfers paused", first ? first.paused : null],
  ] as const;

  return (
    <div className="fig fig-control">
      {rows.map(([label, on]) => (
        <div className="fig-row" key={label}>
          <span className={`dot ${on === null ? "" : on ? "on" : "off"}`} aria-hidden="true" />
          <span className="fig-key wide">{label}</span>
          <span className="fig-val">{on === null ? "—" : on ? "present" : "none"}</span>
        </div>
      ))}
    </div>
  );
}

/** The weights of one index, as a stacked bar. */
export function WeightsFigure({ weights }: { weights: readonly { symbol: string; weight: number }[] | null }) {
  const rows = list(weights).slice(0, 8);
  return (
    <div className="fig fig-weights">
      <div className="stack">
        {rows.length === 0
          ? <i className="stack-empty" />
          : rows.map((w, i) => (
              <i key={w.symbol} style={{ width: `${w.weight * 100}%`, opacity: 1 - i * 0.1 }} title={`${w.symbol} ${weight(w.weight)}`} />
            ))}
      </div>
      <div className="stack-keys">
        {rows.slice(0, 4).map((w) => (
          <span key={w.symbol}>
            {w.symbol} <b className="num">{weight(w.weight, 0)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function FigSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div className="fig-row skeleton" key={i}>
          <span className="fig-bar">
            <i style={{ width: `${70 - i * 12}%` }} />
          </span>
        </div>
      ))}
    </>
  );
}
