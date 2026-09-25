/**
 * Phone home screen: portfolio value or an introduction, the next step
 * (connect, fund or buy), the week's top traders and the market list.
 */

import { useMemo, useState } from "react";
import {
  api,
  type IndexList,
  type Leaderboard as Board,
  type Market,
  type Portfolio as PortfolioDto,
  type Profile,
} from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { displayName, list, signedMoney, signedReturn, usd } from "../lib/format.ts";
import { useWallet } from "../features/wallet/WalletContext.tsx";
import { useCountUp } from "../lib/motion.ts";
import { go } from "../lib/router.ts";
import { TokenLogo } from "../components/TokenLogo.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { TransferSheet } from "../features/wallet/TransferSheet.tsx";
import { Face } from "../features/people/Face.tsx";
import { HoldingLogos, holdingsOf } from "../features/leaderboard/HoldingLogos.tsx";
import { Medal } from "../features/leaderboard/Trophy.tsx";
import { CompanyRow } from "../components/CompanyRow.tsx";
import { ConnectSheet } from "../features/wallet/ConnectSheet.tsx";
import { MIN_BUY_USD } from "../lib/limits.ts";

const TABS = [
  { key: "companies", label: "Companies" },
  { key: "baskets", label: "Baskets" },
  { key: "gainers", label: "Gainers" },
  { key: "losers", label: "Losers" },
] as const;

type Tab = (typeof TABS)[number]["key"];

export function Home({ market }: { market: Market | null }) {
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>("companies");
  const [sheet, setSheet] = useState<"connect" | "transfer" | "trade" | null>(null);

  const portfolio = useAsync<PortfolioDto | null>(
    (signal) => (wallet.address ? api.portfolio(wallet.address, signal) : Promise.resolve(null)),
    [wallet.address],
    { pollMs: 60_000 },
  );
  const me = useAsync<Profile | null>(
    (signal) => (wallet.address ? api.profile(wallet.address, null, signal) : Promise.resolve(null)),
    [wallet.address],
  );
  const board = useAsync<Board>(
    (signal) => api.leaderboard({ hours: 24 * 7, sortBy: "return", limit: 3, minVolumeUsd: 25 }, signal),
    [],
    { pollMs: 5 * 60_000 },
  );
  const indexes = useAsync<IndexList>((signal) => api.indexes(signal), []);

  const changeBySymbol = new Map(list(market?.tokens).map((t) => [t.symbol, t.change24hPct]));
  const held = [
    ...list(portfolio.data?.positions).map((p) => ({ symbol: p.symbol, valueUsd: p.valueUsd ?? 0 })),
    ...list(portfolio.data?.elsewhere).map((e) => ({ symbol: e.symbol, valueUsd: e.valueUsd ?? 0 })),
  ].filter((h) => h.valueUsd > 0);
  const inCompanies = held.reduce((sum, h) => sum + h.valueUsd, 0);
  const cash = portfolio.data?.cash.usdcUsd ?? 0;
  const total = inCompanies + cash;
  const today = held.reduce((sum, h) => {
    const change = changeBySymbol.get(h.symbol);
    if (change == null || change <= -100) return sum;
    return sum + (h.valueUsd - h.valueUsd / (1 + change / 100));
  }, 0);
  const shownTotal = useCountUp(portfolio.data && held.length ? total : null);

  const stage: "connect" | "loading" | "fund" | "buy" | "own" = !wallet.address
    ? "connect"
    : !portfolio.data
      ? portfolio.error
        ? "buy"
        : "loading"
      : held.length > 0
        ? "own"
        : cash >= MIN_BUY_USD
          ? "buy"
          : "fund";

  const who = wallet.address ? displayName(wallet.address, me.data?.name, me.data?.handle) : null;

  return (
    <div className="home">
      <header className="home-top">
        {wallet.address ? (
          <a className="home-hello" href="/portfolio" onClick={go("/portfolio")}>
            <Face wallet={wallet.address} avatar={me.data?.avatar} size={34} />
            <span>
              Welcome, <b>{who}</b>
            </span>
          </a>
        ) : (
          <span className="home-hello">
            <span className="home-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="1" y="3" width="16" height="3" rx="1.5" fill="currentColor" />
                <rect x="1" y="7.5" width="11" height="3" rx="1.5" fill="currentColor" opacity="0.72" />
                <rect x="1" y="12" width="6.5" height="3" rx="1.5" fill="currentColor" opacity="0.44" />
              </svg>
            </span>
            <span>
              Welcome to <b>BasketX</b>
            </span>
          </span>
        )}
        <a className="round-btn" href="/learn" onClick={go("/learn")} aria-label="How it works">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.4M12 16.6v.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </a>
      </header>

      {stage === "loading" ? (
        <section className="home-hero" aria-busy="true">
          <p className="home-kicker">Your balance</p>
          <span className="shimmer" style={{ display: "block", height: 52, width: "70%", borderRadius: 14 }} />
          <span className="shimmer" style={{ display: "block", height: 18, width: "45%", marginTop: 12, borderRadius: 8 }} />
          <span className="shimmer" style={{ display: "block", height: 64, marginTop: 18, borderRadius: 18 }} />
        </section>
      ) : stage === "own" ? (
        <section className="home-hero">
          <p className="home-kicker">Your balance</p>
          <h1 className="home-balance num">{usd(shownTotal)}</h1>
          <p className={`home-today num ${Math.abs(today) < 0.005 ? "muted" : today > 0 ? "up" : "down"}`}>
            {signedUsd(today)}
            {inCompanies > 0 ? ` (${signedPct(today / Math.max(1e-9, inCompanies - today))})` : ""}{" "}
            <span className="muted">today</span>
          </p>
          <div className="home-split">
            <span>
              <small>In companies</small>
              <b className="num">{usd(inCompanies)}</b>
            </span>
            <span>
              <small>Cash</small>
              <b className="num">{usd(cash)}</b>
            </span>
          </div>
        </section>
      ) : (
        <section className="home-hero">
          <h1 className="home-headline">Buy pre-IPO stocks before everyone else.</h1>
          <p className="home-sub">
            {stage === "connect"
              ? "Connect a wallet to begin."
              : stage === "fund"
                ? "Make a deposit to begin."
                : `OpenAI, SpaceX and six more, from $${MIN_BUY_USD}.`}
          </p>
          {stage === "connect" ? (
            <button className="btn-go" onClick={() => setSheet("connect")}>
              Connect wallet
            </button>
          ) : stage === "fund" ? (
            <button className="btn-go" onClick={() => setSheet("transfer")}>
              Deposit
            </button>
          ) : (
            <a className="btn-go" href="/companies" onClick={go("/companies")}>
              Buy your first company
            </a>
          )}
        </section>
      )}

      <TradersCard board={board.data} error={board.error} />

      <section className="home-markets">
        <h2>Markets</h2>
        <div className="home-tabs" role="tablist" aria-label="Markets">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? "on" : ""}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "baskets" ? (
          <BasketRows indexes={indexes.data} market={market} />
        ) : (
          <CompanyRows market={market} tab={tab} />
        )}
      </section>

      <div className="home-pills">
        <button className="dark-pill" onClick={() => setSheet("trade")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 4v16M7 4 3.5 7.5M7 4l3.5 3.5M17 20V4m0 16-3.5-3.5M17 20l3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Trade
        </button>
        <button className="dark-pill" onClick={() => setSheet(wallet.address ? "transfer" : "connect")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 8h14m0 0-4-4m4 4-4 4M20 16H6m0 0 4-4m-4 4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Transfer
        </button>
      </div>

      {sheet === "connect" ? (
        <ConnectSheet onClose={() => setSheet(null)} />
      ) : sheet === "transfer" ? (
        <TransferSheet onClose={() => setSheet(null)} />
      ) : sheet === "trade" ? (
        <TradeSheet market={market} onClose={() => setSheet(null)} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ traders */

export function TradersCard({ board, error }: { board: Board | null; error: string | null }) {
  const entries = list(board?.entries).slice(0, 3);
  return (
    <section className="traders-card">
      <div className="traders-card-head">
        <span className="tc-title">
          <b>Traders of the week</b>
          <small>Best return · last 7 days</small>
        </span>
        <a className="tc-all" href="/traders" onClick={go("/traders")}>
          See all
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </div>
      {!board && !error ? (
        <div className="traders-card-rows">
          {[0, 1, 2].map((i) => (
            <span key={i} className="traders-card-row ghost" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="traders-card-empty">
          No wallet has traded $25 or more this week yet.{" "}
          <a href="/traders" onClick={go("/traders")}>
            See every trader
          </a>
        </p>
      ) : (
        <>
          <div className="tc-cols" aria-hidden="true">
            <span>Trader</span>
            <span>Return</span>
          </div>
          <div className="traders-card-rows">
            {entries.map((entry, i) => (
              <a
                key={entry.owner}
                className="traders-card-row"
                href={`/traders/${entry.owner}`}
                onClick={go(`/traders/${entry.owner}`)}
              >
                <Medal rank={i + 1} size={24} />
                <Face wallet={entry.owner} avatar={entry.avatar} size={38} />
                <span className="traders-card-who">
                  <b>{displayName(entry.owner, entry.name, entry.handle)}</b>
                  <HoldingLogos symbols={holdingsOf(entry)} size={16} />
                </span>
                <span className="traders-card-figures">
                  <b className={`tc-pct num ${entry.returnFraction >= 0 ? "up" : "down"}`}>
                    {signedReturn(entry.returnFraction, 2)}
                  </b>
                  <small className="num">{signedMoney(entry.pnlUsd)}</small>
                </span>
              </a>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ markets */

function CompanyRows({ market, tab }: { market: Market | null; tab: Exclude<Tab, "baskets"> }) {
  if (!market) {
    return (
      <div className="rows">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="row ghost" />
        ))}
      </div>
    );
  }
  const tokens = [...list(market.tokens)];
  const rows =
    tab === "gainers"
      ? tokens.filter((t) => (t.change24hPct ?? 0) > 0).sort((a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0))
      : tab === "losers"
        ? tokens.filter((t) => (t.change24hPct ?? 0) < 0).sort((a, b) => (a.change24hPct ?? 0) - (b.change24hPct ?? 0))
        : tokens.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  if (rows.length === 0) {
    return <p className="positions-empty">{tab === "gainers" ? "Nothing is up today." : "Nothing is down today."}</p>;
  }
  return (
    <div className="rows">
      {rows.map((t) => (
        <CompanyRow key={t.mint} token={t} />
      ))}
    </div>
  );
}

function BasketRows({ indexes, market }: { indexes: IndexList | null; market: Market | null }) {
  const change = useMemo(() => new Map(list(market?.tokens).map((t) => [t.symbol, t.change24hPct])), [market]);
  if (!indexes) {
    return (
      <div className="rows">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="row ghost" />
        ))}
      </div>
    );
  }
  const baskets = list(indexes.indexes).filter((b) => list(b.weights).length > 0);
  return (
    <div className="rows">
      {baskets.map((b) => {
        const weights = list(b.weights);
        // The day's move of the basket is its companies' moves, by weight.
        const covered = weights.filter((w) => change.get(w.symbol) != null);
        const total = covered.reduce((sum, w) => sum + w.weight, 0);
        const move = total > 0 ? covered.reduce((sum, w) => sum + w.weight * change.get(w.symbol)!, 0) / total : null;
        const page = `/baskets/${b.id}`;
        return (
          <a key={b.id} className="row" href={page} onClick={go(page)}>
            <span className="basket-logos" aria-hidden="true">
              {weights.slice(0, 3).map((w) => (
                <TokenLogo key={w.symbol} symbol={w.symbol} size={26} badge={false} />
              ))}
            </span>
            <span className="row-main">
              <b>{b.name}</b>
              <small>
                {weights.length} {weights.length === 1 ? "company" : "companies"}
              </small>
            </span>
            <span className="row-side">
              <b className={`num ${move == null ? "muted" : move >= 0 ? "up" : "down"}`}>
                {move == null ? "—" : `${move >= 0 ? "+" : ""}${move.toFixed(2)}%`}
              </b>
              <small className="muted">today</small>
            </span>
          </a>
        );
      })}
      <a className="row more" href="/baskets" onClick={go("/baskets")}>
        <span className="row-main">
          <b>Every basket, and build your own</b>
        </span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    </div>
  );
}

/** Pick what to trade; its page has the chart and the buy and sell panel. */
export function TradeSheet({ market, onClose }: { market: Market | null; onClose: () => void }) {
  return (
    <Sheet title="Trade" onClose={onClose}>
      <p className="note" style={{ marginBottom: 6 }}>
        Pick a company to buy or sell. You see the exact price before you sign.
      </p>
      <div className="rows">
        {list(market?.tokens)
          .slice()
          .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
          .map((t) => (
            <CompanyRow key={t.mint} token={t} onPick={onClose} />
          ))}
        <a
          className="row more"
          href="/baskets"
          onClick={(event) => {
            onClose();
            go("/baskets")(event);
          }}
        >
          <span className="row-main">
            <b>Or buy a basket of them</b>
            <small>Several companies in one go</small>
          </span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------- words */

function signedUsd(value: number): string {
  if (Math.abs(value) < 0.005) return usd(0);
  return `${value > 0 ? "+" : "−"}${usd(Math.abs(value))}`;
}

function signedPct(fraction: number): string {
  const pct = fraction * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.005) return "0.00%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`;
}
