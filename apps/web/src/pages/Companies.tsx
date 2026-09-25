import { useLivePrices } from "../lib/live.ts";
import { TickerTape, Ticking } from "../components/Ticker.tsx";
import { useEffect, useRef, useState } from "react";
import { api, type Intraday, type Market, type MarketToken } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { list, price, usdCompact } from "../lib/format.ts";
import { WHAT_THIS_IS, SECTOR_WORDS } from "../lib/words.ts";
import { navigate, go } from "../lib/router.ts";
import { PageHead } from "../components/PageHead.tsx";
import { TokenLogo } from "../components/TokenLogo.tsx";
import { Sparkline } from "../components/charts/PriceChart.tsx";

export function Companies({ market, loading }: { market: Market | null; loading: boolean }) {
  const intraday = useAsync<Intraday>((signal) => api.intraday(24, signal), [], { pollMs: 5 * 60_000 });
  const liveIntraday = useLivePrices(intraday.data, market);

  if (!market && loading) {
    return (
      <>
        <PageHead title="Companies" />
        <div className="stock-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div className="shimmer" key={i} style={{ height: 236 }} />
          ))}
        </div>
      </>
    );
  }
  if (!market) return <div className="empty">Could not load prices just now. This page will retry on its own.</div>;

  return (
    <>
      <PageHead title="Companies" />
      <TickerTape tokens={market.tokens} />
      <p className="lede">
        {WHAT_THIS_IS} You can put in any amount from $5; you do not need to buy a whole token.{" "}
        <a href="/learn" onClick={go("/learn")} style={{ textDecoration: "underline" }}>
          How it works
        </a>
      </p>

      <div className="stock-grid">
        {list(market.tokens).map((token, i) => (
          <StockCard key={token.mint} token={token} line={liveIntraday?.prices[token.symbol] ?? null} order={i} />
        ))}
      </div>
    </>
  );
}

function StockCard({
  token,
  line,
  order,
}: {
  token: MarketToken;
  line: readonly (number | null)[] | null;
  order: number;
}) {
  const [flipped, setFlipped] = useState(false);
  // Focus follows the card over, so a keyboard user is never left on the
  // face that just turned away.
  const front = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const turned = useRef(false);
  useEffect(() => {
    if (flipped) close.current?.focus({ preventScroll: true });
    else if (turned.current) front.current?.focus({ preventScroll: true });
    turned.current = true;
  }, [flipped]);
  const move = token.change24hPct;
  const up = (move ?? 0) >= 0;
  const page = `/companies/${token.symbol.toLowerCase()}`;
  const tokenCap = token.marketUsd !== null ? token.marketUsd * token.supplyUi : null;

  return (
    <div className={`flip cascade${flipped ? " flipped" : ""}`} style={{ "--i": order } as React.CSSProperties}>
      <div className="flip-inner">
        <button
          ref={front}
          className="flip-face stock-card"
          onClick={() => setFlipped(true)}
          aria-expanded={flipped}
          aria-label={`${token.name}: ${price(token.marketUsd)}, ${move == null ? "no change today" : `${move.toFixed(2)}% today`}. Show details.`}
          aria-hidden={flipped}
          tabIndex={flipped ? -1 : 0}
        >
          <span className="stock-head">
            <TokenLogo symbol={token.symbol} size={44} />
            <span className="stock-name">
              <b>{token.name}</b>
              <small>{token.symbol}</small>
            </span>
            <span className="stock-price">
              <b className="num">
                <Ticking value={token.marketUsd} />
              </b>
              <small className={`num ${move == null ? "muted" : up ? "up" : "down"}`}>
                {move == null ? "—" : (
                  <>
                    <Arrow up={up} /> {`${up ? "+" : ""}${move.toFixed(2)}%`} <em>24H</em>
                  </>
                )}
              </small>
            </span>
          </span>
          <span className="stock-line">
            {line ? <Sparkline values={line} up={up} height={108} /> : <span className="shimmer" style={{ display: "block", height: 108 }} />}
          </span>
          {token.paused ? <span className="pill warn stock-flag">Paused by the issuer</span> : null}
        </button>

        <div
          className="flip-face flip-back stock-card"
          aria-hidden={!flipped}
          onKeyDown={(event) => {
            if (event.key === "Escape") setFlipped(false);
          }}
        >
          <div className="stock-head">
            <TokenLogo symbol={token.symbol} size={40} />
            <span className="stock-name">
              <b>{token.symbol}</b>
              <small>{token.name}</small>
            </span>
            <button
              ref={close}
              className="icon-btn sm"
              onClick={() => setFlipped(false)}
              aria-label="Turn the card back"
              tabIndex={flipped ? 0 : -1}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="chips">
            {token.sectors.map((s) => (
              <span className="chip" key={s}>
                {SECTOR_WORDS[s] ?? s}
              </span>
            ))}
            <span className="chip">Pre-IPO</span>
            <span className="chip">Solana</span>
          </div>

          <dl className="stock-facts">
            <div>
              <dt>Token market cap</dt>
              <dd className="num">{usdCompact(tokenCap)}</dd>
            </div>
            <div>
              <dt>Traded today</dt>
              <dd className="num">{usdCompact(token.volume24hUsd ?? null)}</dd>
            </div>
            <div>
              <dt>Holders</dt>
              <dd className="num">{token.holders == null ? "—" : token.holders.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>24h change</dt>
              <dd className={`num ${move == null ? "muted" : up ? "up" : "down"}`}>
                {move == null ? "—" : `${up ? "+" : ""}${move.toFixed(2)}%`}
              </dd>
            </div>
          </dl>

          <button className="btn-mint stock-cta" onClick={() => navigate(page)} tabIndex={flipped ? 0 : -1}>
            View asset
          </button>
        </div>
      </div>
    </div>
  );
}

function Arrow({ up }: { up: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" style={{ verticalAlign: "-1px" }}>
      <path
        d={up ? "M1.5 9.5l3.2-3.2 2 2L10.5 4.5M7.5 4.5h3v3" : "M1.5 2.5l3.2 3.2 2-2 3.8 3.8M7.5 7.5h3v-3"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
