/**
 * Desktop home: a price strip, a rotating banner with live figures, then top
 * traders, baskets and the full company table.
 */

import { useEffect, useMemo, useState } from "react";
import {
  api,
  type History,
  type IndexList,
  type Intraday,
  type Leaderboard as Board,
  type Market,
  type MarketToken,
} from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { displayName, list, pct, price, signedMoney, usd, usdCompact } from "../lib/format.ts";
import { basketSeries, firstValue, type HistoryTable } from "../lib/series.ts";
import { navigate, go } from "../lib/router.ts";
import { useWallet } from "../features/wallet/WalletContext.tsx";
import { useLivePrices } from "../lib/live.ts";
import { Ticking } from "../components/Ticker.tsx";
import { reducedMotion } from "../lib/motion.ts";
import { TokenLogo } from "../components/TokenLogo.tsx";
import { Sparkline } from "../components/charts/PriceChart.tsx";
import { growthOf } from "../features/baskets/PerformanceCard.tsx";
import { ConnectSheet } from "../features/wallet/ConnectSheet.tsx";
import { Face } from "../features/people/Face.tsx";
import { HoldingLogos, holdingsOf } from "../features/leaderboard/HoldingLogos.tsx";
import { Trophy } from "../features/leaderboard/Trophy.tsx";
import { BasketCover } from "../features/baskets/BasketCover.tsx";

type Tab = "all" | "gainers" | "losers";
type Weights = readonly { readonly symbol: string; readonly weight: number }[];

export function Explore({ market }: { market: Market | null }) {
  const wallet = useWallet();
  const [connect, setConnect] = useState(false);
  const board = useAsync<Board>(
    (signal) => api.leaderboard({ hours: 24 * 30, sortBy: "return", limit: 4, minVolumeUsd: 25 }, signal),
    [],
    { pollMs: 5 * 60_000 },
  );
  const indexes = useAsync<IndexList>((signal) => api.indexes(signal), []);
  const intradayFetched = useAsync<Intraday>((signal) => api.intraday(168, signal), [], { pollMs: 5 * 60_000 });
  const historyFetched = useAsync<History>((signal) => api.history(365, signal), []);
  // Lines and figures end on the live price between fetches (lib/live.ts).
  const intraday = { data: useLivePrices(intradayFetched.data, market) };
  const history = { data: useLivePrices(historyFetched.data, market) };

  const everything = useMemo<Weights>(
    () => list(list(indexes.data?.indexes).find((i) => i.id === "pre8")?.weights),
    [indexes.data],
  );
  const tokens = list(market?.tokens);

  return (
    <div className="ex">
      <header className="ex-title">
        <div>
          <h1>Explore</h1>
          <p>Tokenized pre-IPO companies on Solana, bought with USDC and held in your own wallet.</p>
        </div>
        <dl className="ex-facts">
          <div>
            <dt>Companies</dt>
            <dd className="num">{tokens.length || "—"}</dd>
          </div>
        </dl>
      </header>

      <PriceStrip tokens={tokens} />

      <Banner
        tokens={tokens}
        history={history.data}
        everything={everything}
        traders={list(board.data?.entries)}
        onStart={() => (wallet.address ? navigate("/companies") : setConnect(true))}
      />

      <section className="ex-section">
        <div className="ex-head">
          <h2>Top traders</h2>
          <span className="ex-head-note">Best return over 30 days, read from the chain</span>
          <a href="/traders" onClick={go("/traders")}>
            Leaderboard
          </a>
        </div>
        <div className="ex-grid">
          {!board.data
            ? Array.from({ length: 4 }, (_, i) => <span key={i} className="ex-card ghost" />)
            : list(board.data.entries)
                .slice(0, 4)
                .map((entry, i) => {
                  const page = `/traders/${entry.owner}`;
                  const up = entry.returnFraction >= 0;
                  return (
                    <a key={entry.owner} className="ex-card ex-trader" href={page} onClick={go(page)}>
                      <span className="ex-trader-top">
                        <Face wallet={entry.owner} avatar={entry.avatar} size={36} />
                        <span className="ex-trader-id">
                          <b>{displayName(entry.owner, entry.name, entry.handle)}</b>
                          <small className="num">
                            {entry.handle ? `@${entry.handle}` : `Traded ${usdCompact(entry.volumeUsd)}`}
                          </small>
                        </span>
                        {i < 3 ? (
                          <span className="ex-trophy">
                            <Trophy rank={(i + 1) as 1 | 2 | 3} size={30} />
                          </span>
                        ) : (
                          <span className="ex-rank num">#{i + 1}</span>
                        )}
                      </span>
                      <span className="ex-trader-return">
                        <b className={`num ${up ? "up" : "down"}`}>{pct(entry.returnFraction * 100, 2)}</b>
                        <small>30-day return</small>
                      </span>
                      <span className="ex-trader-meta">
                        <span>
                          Profit <b className={`num ${entry.pnlUsd >= 0 ? "up" : "down"}`}>{signedMoney(entry.pnlUsd)}</b>
                        </span>
                        <span>
                          Trades <b className="num">{entry.trades}</b>
                        </span>
                      </span>
                      <span className="ex-trader-foot">
                        <HoldingLogos symbols={holdingsOf(entry)} size={18} />
                      </span>
                    </a>
                  );
                })}
        </div>
      </section>

      <section className="ex-section">
        <div className="ex-head">
          <h2>Baskets</h2>
          <span className="ex-head-note">Several companies, bought in one approval</span>
          <a href="/baskets" onClick={go("/baskets")}>
            View all
          </a>
        </div>
        <div className="ex-grid">
          {!indexes.data
            ? Array.from({ length: 4 }, (_, i) => <span key={i} className="ex-card ghost" />)
            : list(indexes.data.indexes)
                .filter((b) => list(b.weights).length > 0)
                .slice(0, 4)
                .map((b) => {
                  const weights = list(b.weights);
                  const g = history.data ? growthOf(history.data, weights) : null;
                  const page = `/baskets/${b.id}`;
                  return (
                    <a key={b.id} className="ex-card ex-basket" href={page} onClick={go(page)}>
                      <BasketCover id={b.id} weights={weights} />
                      <span className="ex-basket-body">
                        <b className="ex-basket-name">{b.name}</b>
                        <p>{b.description}</p>
                      </span>
                      <span className="ex-basket-foot">
                        {g ? (
                          <>
                            <b className={`num ${g.change >= 0 ? "up" : "down"}`}>{pct(g.change * 100, 1)}</b>
                            <small>since {g.since}</small>
                          </>
                        ) : (
                          <small>&nbsp;</small>
                        )}
                        <small className="ex-basket-count">
                          {weights.length} {weights.length === 1 ? "company" : "companies"}
                        </small>
                      </span>
                    </a>
                  );
                })}
        </div>
      </section>

      <Companies market={market} intraday={intraday.data} />

      {connect ? <ConnectSheet onClose={() => setConnect(false)} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------- the prices */

/** Every company's price, in a strip that scrolls sideways. */
/** Every company's price, looping right to left; the second copy fills the seam. */
function PriceStrip({ tokens }: { tokens: readonly MarketToken[] }) {
  if (tokens.length === 0) return <div className="ex-strip ghost" />;
  const row = (copy: number) =>
    tokens.map((t) => {
      const move = t.change24hPct;
      const up = (move ?? 0) >= 0;
      const page = `/companies/${t.symbol.toLowerCase()}`;
      return (
        <a
          key={`${copy}-${t.symbol}`}
          className={copy === 0 ? "ex-tick" : "ex-tick copy"}
          href={page}
          onClick={go(page)}
          tabIndex={copy === 0 ? undefined : -1}
          aria-hidden={copy === 0 ? undefined : true}
        >
          <TokenLogo symbol={t.symbol} size={28} badge={false} />
          <span className="ex-tick-body">
            <b>{t.name}</b>
            <span className="ex-tick-line">
              <span className="num">
                <Ticking value={t.marketUsd} format={price} />
              </span>
              <span className={`num ${move == null ? "muted" : up ? "up" : "down"}`}>
                {move == null ? "—" : `${up ? "+" : ""}${move.toFixed(2)}%`}
              </span>
            </span>
          </span>
        </a>
      );
    });
  return (
    <div className="ex-strip" aria-label="Prices">
      <div className="ex-strip-track">
        {row(0)}
        {row(1)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ the banner */

interface Slide {
  readonly key: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly primary: { readonly label: string; readonly action: () => void };
  readonly secondary?: { readonly label: string; readonly href: string };
  readonly panel: React.ReactNode;
}

function Banner({
  tokens,
  history,
  everything,
  traders,
  onStart,
}: {
  tokens: readonly MarketToken[];
  history: History | null;
  everything: Weights;
  traders: Board["entries"];
  onStart: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);

  const movers = [...tokens]
    .filter((t) => t.change24hPct != null)
    .sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))
    .slice(0, 3);

  // What $1,000 in the Everything basket did over the last 90 days, from
  // the first day every company in it had a price.
  const line = useMemo(() => {
    if (!history || everything.length === 0) return null;
    const from = Math.max(0, history.days.length - 91);
    const table: HistoryTable = {
      days: history.days.slice(from),
      prices: Object.fromEntries(Object.entries(history.prices).map(([s, v]) => [s, v.slice(from)])),
    };
    const start = Math.max(0, ...everything.map((w) => firstValue(table.prices[w.symbol] ?? [])));
    const values = basketSeries(table, everything, 1_000, start).slice(start);
    const last = [...values].reverse().find((v): v is number => v !== null) ?? null;
    return last === null ? null : { values, last, change: last / 1_000 - 1 };
  }, [history, everything]);

  const slides: Slide[] = [
    {
      key: "start",
      eyebrow: "Pre-IPO on Solana",
      title: "Invest in private companies before they go public.",
      body: "OpenAI, SpaceX, Anthropic and five more, as tokens you hold in your own wallet. From $5.",
      primary: { label: "Start investing", action: onStart },
      secondary: { label: "How it works", href: "/learn" },
      panel: (
        <>
          <p className="ex-panel-label">Moving most today</p>
          {movers.map((t) => {
            const up = (t.change24hPct ?? 0) >= 0;
            return (
              <div key={t.symbol} className="ex-panel-row">
                <TokenLogo symbol={t.symbol} size={28} badge={false} />
                <span className="ex-panel-name">
                  <b>{t.name}</b>
                  <small className="num">{price(t.marketUsd)}</small>
                </span>
                <b className={`num ${up ? "up" : "down"}`}>
                  {up ? "+" : ""}
                  {t.change24hPct!.toFixed(2)}%
                </b>
              </div>
            );
          })}
        </>
      ),
    },
    {
      key: "baskets",
      eyebrow: "Baskets",
      title: "Own the whole frontier in one purchase.",
      body: "Ready-made baskets of these companies, weighted so no single name dominates, bought in one approval.",
      primary: { label: "Explore baskets", action: () => navigate("/baskets") },
      secondary: { label: "Build your own", href: "/build" },
      panel: (
        <>
          <p className="ex-panel-label">The Everything basket · 90 days</p>
          <div className="ex-panel-figure">
            <b className={`num ${(line?.change ?? 0) >= 0 ? "up" : "down"}`}>{line ? pct(line.change * 100, 1) : "—"}</b>
            <small className="num">{line ? `$1,000 became ${usd(line.last)}` : ""}</small>
          </div>
          <div className="ex-panel-line">
            {line ? <Sparkline values={line.values} up={line.change >= 0} height={72} /> : null}
          </div>
        </>
      ),
    },
    {
      key: "traders",
      eyebrow: "Traders",
      title: "Follow the traders who are winning.",
      body: "Every record is read from the chain. See what they hold, follow their trades, or copy their mix.",
      primary: { label: "See the leaderboard", action: () => navigate("/traders") },
      panel: (
        <>
          <p className="ex-panel-label">Best return, 30 days</p>
          {traders.slice(0, 3).map((t, i) => (
            <div key={t.owner} className="ex-panel-row">
              <span className="ex-panel-trophy">
                <Trophy rank={(i + 1) as 1 | 2 | 3} size={26} />
              </span>
              <Face wallet={t.owner} avatar={t.avatar} size={28} />
              <span className="ex-panel-name">
                <b>{displayName(t.owner, t.name, t.handle)}</b>
                <small>{holdingsOf(t).length} {holdingsOf(t).length === 1 ? "company" : "companies"}</small>
              </span>
              <b className={`num ${t.returnFraction >= 0 ? "up" : "down"}`}>{pct(t.returnFraction * 100, 2)}</b>
            </div>
          ))}
        </>
      ),
    },
    {
      key: "create",
      eyebrow: "Create",
      title: "Build a basket and share it.",
      body: "Choose the companies and the weights, publish it, and anyone can buy your mix from its link.",
      primary: { label: "Create a basket", action: () => navigate("/build") },
      panel: (
        <>
          <p className="ex-panel-label">An example mix</p>
          {[
            ["OPENAI", 45],
            ["ANTHROPIC", 35],
            ["SPACEX", 20],
          ].map(([symbol, weight]) => (
            <div key={symbol} className="ex-panel-weight">
              <TokenLogo symbol={String(symbol)} size={24} badge={false} />
              <span className="ex-panel-bar">
                <i style={{ width: `${weight}%` }} />
              </span>
              <b className="num">{weight}%</b>
            </div>
          ))}
        </>
      ),
    },
  ];

  const count = slides.length;
  useEffect(() => {
    if (held || reducedMotion()) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % count), 8000);
    return () => clearInterval(id);
  }, [held, count]);

  return (
    <section
      className="ex-banner"
      aria-roledescription="carousel"
      aria-label="What you can do here"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {slides.map((slide, i) => (
        <article
          key={slide.key}
          className={`ex-slide${i === index ? " on" : ""}`}
          aria-hidden={i !== index}
          aria-roledescription="slide"
          aria-label={`${i + 1} of ${count}`}
        >
          <div className="ex-slide-text">
            <p className="ex-eyebrow">{slide.eyebrow}</p>
            <h2>{slide.title}</h2>
            <p className="ex-slide-body">{slide.body}</p>
            <div className="ex-slide-actions">
              <button className="ex-btn light" onClick={slide.primary.action} tabIndex={i === index ? 0 : -1}>
                {slide.primary.label}
              </button>
              {slide.secondary ? (
                <a
                  className="ex-btn ghost"
                  href={slide.secondary.href}
                  onClick={go(slide.secondary.href)}
                  tabIndex={i === index ? 0 : -1}
                >
                  {slide.secondary.label}
                </a>
              ) : null}
            </div>
          </div>
          <div className="ex-panel">{slide.panel}</div>
        </article>
      ))}
      <div className="ex-dots" role="tablist" aria-label="Choose a slide">
        {slides.map((slide, i) => (
          <button
            key={slide.key}
            role="tab"
            aria-selected={i === index}
            aria-label={`Show ${slide.eyebrow}`}
            className={i === index ? "on" : ""}
            onClick={() => setIndex(i)}
          />
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------------- the companies */

function Companies({ market, intraday }: { market: Market | null; intraday: Intraday | null }) {
  const [tab, setTab] = useState<Tab>("all");
  const tokens = [...list(market?.tokens)];
  const rows =
    tab === "gainers"
      ? tokens.filter((t) => (t.change24hPct ?? 0) > 0).sort((a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0))
      : tab === "losers"
        ? tokens.filter((t) => (t.change24hPct ?? 0) < 0).sort((a, b) => (a.change24hPct ?? 0) - (b.change24hPct ?? 0))
        : tokens.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const day = (symbol: string) => intraday?.prices[symbol]?.slice(-25) ?? null;

  return (
    <section className="ex-section">
      <div className="ex-head">
        <h2>Companies</h2>
        <div className="ex-tabs" role="tablist" aria-label="Which companies">
          {(
            [
              ["all", "All"],
              ["gainers", "Gainers"],
              ["losers", "Losers"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>
        <a href="/companies" onClick={go("/companies")}>
          View all
        </a>
      </div>
      <div className="ex-table">
        {!market ? (
          <div className="rows">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="row ghost" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="positions-empty">{tab === "gainers" ? "Nothing is up today." : "Nothing is down today."}</p>
        ) : (
          <table className="dh-table">
            <thead>
              <tr>
                <th>Company</th>
                <th className="num-col">Price</th>
                <th className="num-col">24h</th>
                <th className="spark-col">Last 24 hours</th>
                <th className="num-col">Market cap</th>
                <th className="num-col">Traded today</th>
                <th className="num-col">Holders</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <CompanyLine key={t.mint} token={t} line={day(t.symbol)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function CompanyLine({ token, line }: { token: MarketToken; line: readonly (number | null)[] | null }) {
  const page = `/companies/${token.symbol.toLowerCase()}`;
  const move = token.change24hPct;
  const up = (move ?? 0) >= 0;
  const cap = token.marketUsd !== null ? token.marketUsd * token.supplyUi : null;
  return (
    <tr className="clickable" onClick={() => navigate(page)}>
      <td>
        <a className="dh-company" href={page} onClick={go(page)}>
          <TokenLogo symbol={token.symbol} size={32} />
          <span>
            <b>{token.name}</b>
            <small>{token.symbol}</small>
          </span>
        </a>
      </td>
      <td className="num-col num">
        <Ticking value={token.marketUsd} format={price} />
      </td>
      <td className={`num-col num ${move == null ? "muted" : up ? "up" : "down"}`}>
        {move == null ? "—" : `${up ? "+" : ""}${move.toFixed(2)}%`}
      </td>
      <td className="spark-col">{line ? <Sparkline values={line} up={up} height={30} /> : null}</td>
      <td className="num-col num">{usdCompact(cap)}</td>
      <td className="num-col num">{usdCompact(token.volume24hUsd ?? null)}</td>
      <td className="num-col num">{token.holders == null ? "—" : token.holders.toLocaleString("en-US")}</td>
      <td className="action-col">
        <a className="ex-btn outline small" href={page} onClick={go(page)}>
          Trade
        </a>
      </td>
    </tr>
  );
}
