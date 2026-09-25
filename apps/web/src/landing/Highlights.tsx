/** Three product highlights under the copy-trading section, each illustrated with live data. */

import { TokenLogo } from "../components/TokenLogo.tsx";
import { Sparkline } from "../components/charts/PriceChart.tsx";
import { Trophy } from "../features/leaderboard/Trophy.tsx";
import { Face } from "../features/people/Face.tsx";
import { api, type History, type Leaderboard, type LeaderboardEntry, type Market, type MarketToken } from "../lib/api.ts";
import { displayName, list, price, signedReturn } from "../lib/format.ts";
import { MarketContext } from "../lib/market.ts";
import { go } from "../lib/router.ts";
import { useAsync } from "../lib/useAsync.ts";

/** Days of history behind the trend lines. */
const TREND_DAYS = 90;

export function HighlightsSection({ market }: { market: Market | null }) {
  // More than three are asked for: the API drops rows whose positions it cannot confirm on chain.
  const board = useAsync<Leaderboard>(
    (signal) => api.leaderboard({ hours: 24 * 30, sortBy: "return", limit: 6, minVolumeUsd: 25 }, signal),
    [],
  );
  const history = useAsync<History>((signal) => api.history(TREND_DAYS, signal), []);
  const tokens = list(market?.tokens);

  return (
    <MarketContext.Provider value={market}>
      <section className="section highlights">
        <h2>
          Pre-IPO, <span>without the paperwork.</span>
        </h2>
        <div className="hl-grid">
          <Highlight
            index="01"
            title="Every private company, priced live"
            text="OpenAI, SpaceX, Anthropic and five more, quoted from live Solana liquidity. Buy one on its own, or a whole basket in a single approval."
            href="/companies"
            cta="Browse companies"
          >
            <PriceList tokens={tokens.slice(0, 4)} />
          </Highlight>
          <Highlight
            index="02"
            title="Follow the traders who are right"
            text="Returns are worked out from on-chain trades, never self-reported. Follow a wallet, or copy its mix with one tap."
            href="/traders"
            cta="Open the leaderboard"
          >
            <MiniPodium entries={board.data ? list(board.data.entries).slice(0, 3) : null} />
          </Highlight>
          <Highlight
            index="03"
            title="The history behind every price"
            text="Months of daily prices for each company, next to the issuer's own valuation, so you can see what you are paying for."
            href="/companies"
            cta="See the charts"
          >
            <Trends tokens={tokens.slice(4, 7)} history={history.data} />
          </Highlight>
        </div>
      </section>
    </MarketContext.Provider>
  );
}

function Highlight({
  index,
  title,
  text,
  href,
  cta,
  children,
}: {
  index: string;
  title: string;
  text: string;
  href: string;
  cta: string;
  children: React.ReactNode;
}) {
  return (
    <article className="hl">
      <div className="hl-figure">{children}</div>
      <p className="hl-index">{index}</p>
      <h3>{title}</h3>
      <p className="hl-text">{text}</p>
      <a className="hl-link" href={href} onClick={go(href)}>
        {cta}
      </a>
    </article>
  );
}

function Change({ pct }: { pct: number | null }) {
  if (pct === null || !Number.isFinite(pct)) return <small className="muted">—</small>;
  return (
    <small className={pct >= 0 ? "up" : "down"}>
      {pct >= 0 ? "+" : "−"}
      {Math.abs(pct).toFixed(2)}%
    </small>
  );
}

function PriceList({ tokens }: { tokens: readonly MarketToken[] }) {
  return (
    <div className="hl-panel" aria-label="Live prices">
      {tokens.length === 0
        ? Array.from({ length: 4 }, (_, i) => <span key={i} className="hl-row ghost" />)
        : tokens.map((t) => (
            <div key={t.symbol} className="hl-row">
              <TokenLogo symbol={t.symbol} size={30} badge={false} />
              <b className="hl-name">{t.name}</b>
              <span className="hl-price num">
                {price(t.marketUsd)}
                <Change pct={t.change24hPct} />
              </span>
            </div>
          ))}
    </div>
  );
}

/** Second, first and third, with the winner raised; the DOM keeps rank order. */
function MiniPodium({ entries }: { entries: readonly LeaderboardEntry[] | null }) {
  const tiers = ["gold", "silver", "bronze"] as const;
  return (
    <div className="hl-podium" aria-label="Top traders this month">
      {entries === null
        ? tiers.map((tier) => <span key={tier} className={`hl-step ${tier} ghost`} />)
        : entries.map((entry, i) => {
            const rank = (i + 1) as 1 | 2 | 3;
            return (
              <div key={entry.owner} className={`hl-step ${tiers[i]}`}>
                <Trophy rank={rank} size={rank === 1 ? 34 : 28} />
                <Face wallet={entry.owner} avatar={entry.avatar} size={rank === 1 ? 44 : 38} />
                <b>{displayName(entry.owner, entry.name, entry.handle)}</b>
                <small className={entry.returnFraction >= 0 ? "up" : "down"}>{signedReturn(entry.returnFraction, 2)}</small>
              </div>
            );
          })}
      {entries !== null
        ? tiers.slice(entries.length).map((tier) => (
            <div key={tier} className={`hl-step ${tier} open`}>
              <span className="hl-open-face" aria-hidden="true">?</span>
              <b>Open spot</b>
              <small className="muted">Start trading</small>
            </div>
          ))
        : null}
    </div>
  );
}

function Trends({ tokens, history }: { tokens: readonly MarketToken[]; history: History | null }) {
  return (
    <div className="hl-panel" aria-label={`${TREND_DAYS}-day price history`}>
      {tokens.length === 0 || !history
        ? Array.from({ length: 3 }, (_, i) => <span key={i} className="hl-row ghost" />)
        : tokens.map((t) => {
            const series = list(history.prices[t.symbol]);
            const known = series.filter((v): v is number => v !== null);
            const first = known[0];
            const last = t.marketUsd ?? known.at(-1);
            const pct = first && last ? (last / first - 1) * 100 : null;
            return (
              <div key={t.symbol} className="hl-row">
                <TokenLogo symbol={t.symbol} size={30} badge={false} />
                <span className="hl-name">
                  <b>{t.name}</b>
                  <small>{TREND_DAYS} days</small>
                </span>
                <span className="hl-spark">
                  <Sparkline values={series} up={(pct ?? 0) >= 0} height={30} />
                </span>
                <span className="hl-price num">
                  {price(t.marketUsd)}
                  <Change pct={pct} />
                </span>
              </div>
            );
          })}
    </div>
  );
}
