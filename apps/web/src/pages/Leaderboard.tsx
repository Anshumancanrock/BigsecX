import { useState } from "react";
import { api, type FeedTrade, type FollowEntry, type Leaderboard as Board } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { list, shares, usd, usdCompact, displayName, signedMoney, signedReturn } from "../lib/format.ts";
import { useWallet } from "../features/wallet/WalletContext.tsx";
import { useCompanyName } from "../lib/market.ts";
import { go } from "../lib/router.ts";
import { Segmented } from "../components/Segmented.tsx";
import { TokenLogo } from "../components/TokenLogo.tsx";
import { WalletPicker } from "../features/wallet/ConnectButton.tsx";
import { Face } from "../features/people/Face.tsx";
import { FollowButton } from "../features/people/FollowButton.tsx";
import { HoldingLogos, holdingsOf } from "../features/leaderboard/HoldingLogos.tsx";
import { PodiumGhost, TopThree, type Metric } from "../features/leaderboard/Podium.tsx";
import { TrophyIcon } from "../features/leaderboard/Trophy.tsx";

const WINDOWS = [
  { label: "24h", hours: 24, words: "the last 24 hours" },
  { label: "7d", hours: 24 * 7, words: "the last 7 days" },
  { label: "30d", hours: 24 * 30, words: "the last 30 days" },
] as const;

const SORTS = [
  { label: "Profit", key: "pnl" },
  { label: "Return", key: "return" },
] as const;

const MIN_VOLUME_USD = 25;

export function Leaderboard() {
  const me = useWallet();
  const [view, setView] = useState<"top" | "following">("top");

  return (
    <div className="people-page">
      <header className="people-head">
        <h1>Leaderboard</h1>
        <p>Real wallets, ranked by what they made on these companies. Read from the chain every few minutes.</p>
      </header>
      <Segmented
        className="pill-seg wide"
        label="Top traders or people you follow"
        options={[
          { value: "top", label: "Top traders" },
          { value: "following", label: "Following" },
        ]}
        value={view}
        onChange={setView}
      />
      {view === "top" ? (
        <Top me={me.address} />
      ) : me.address ? (
        <Following me={me.address} onFind={() => setView("top")} />
      ) : (
        <ConnectToFollow />
      )}
    </div>
  );
}

function Top({ me }: { me: string | null }) {
  const [hours, setHours] = useState<number>(24 * 30);
  const [sortBy, setSortBy] = useState<Metric>("pnl");
  const board = useAsync<Board>(
    (signal) => api.leaderboard({ hours, sortBy, limit: 50, minVolumeUsd: MIN_VOLUME_USD }, signal),
    [hours, sortBy],
  );
  const following = useAsync<readonly FollowEntry[]>(
    (signal) => (me ? api.following(me, signal).then((r) => r.following) : Promise.resolve([])),
    [me],
  );
  const followed = new Set(list(following.data).map((f) => f.wallet));
  const entries = list(board.data?.entries);
  const window_ = WINDOWS.find((w) => w.hours === hours)!;

  return (
    <>
      <div className="people-controls">
        <Segmented
          className="pill-seg small"
          label="Time window"
          options={WINDOWS.map((w) => ({ value: w.hours, label: w.label }))}
          value={hours}
          onChange={setHours}
        />
        <Segmented
          className="pill-seg small"
          label="Rank by"
          options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
          value={sortBy}
          onChange={setSortBy}
        />
      </div>

      {board.error ? (
        <p className="banner bad">Could not load the traders just now.</p>
      ) : !board.data ? (
        <>
          <PodiumGhost />
          <div className="list-card">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className="row ghost tall" />
            ))}
          </div>
        </>
      ) : entries.length === 0 ? (
        <div className="list-card empty-card">
          <span className="empty-icon" aria-hidden="true">
            <TrophyIcon size={26} />
          </span>
          <b>No one on the board yet</b>
          <p>No wallet traded at least $25 in {window_.words}.</p>
          {hours < 24 * 30 ? (
            <button className="pill-btn" onClick={() => setHours(24 * 30)}>
              Try 30 days
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <TopThree entries={entries} metric={sortBy} me={me} followed={followed} />

          {entries.length > 3 ? (
            <section className="list-card">
              <div className="list-card-head">
                <h2>Rankings</h2>
                <span>{window_.words}</span>
              </div>
              <div className="list-cols" aria-hidden="true">
                <span className="col-rank">#</span>
                <span className="col-trader">Trader</span>
                <span className="col-stat desk-only">Worth now</span>
                <span className="col-stat desk-only">Trades</span>
                <span className="col-stat desk-only">Traded</span>
                <span className="col-main">{sortBy === "pnl" ? "Profit" : "Return"}</span>
                <span className="col-follow" />
              </div>
              <div className="rows">
                {entries.slice(3).map((entry, i) => {
                  const rank = i + 4;
                  const main = sortBy === "pnl" ? entry.pnlUsd : entry.returnFraction;
                  const page = `/traders/${entry.owner}`;
                  return (
                    <div key={entry.owner} className="row person">
                      <a className="person-link" href={page} onClick={go(page)}>
                        <span className="rank-num num">{rank}</span>
                        <Face wallet={entry.owner} avatar={entry.avatar} size={40} />
                        <span className="row-main">
                          <b>{displayName(entry.owner, entry.name, entry.handle)}</b>
                          <HoldingLogos symbols={holdingsOf(entry)} label={false} />
                        </span>
                        <span className="col-stat desk-only num">{usdCompact(entry.markValueUsd)}</span>
                        <span className="col-stat desk-only num">{entry.trades}</span>
                        <span className="col-stat desk-only num">{usdCompact(entry.volumeUsd)}</span>
                        <span className="row-side col-main">
                          <b className={`num ${main >= 0 ? "up" : "down"}`}>
                            {sortBy === "pnl" ? signedMoney(entry.pnlUsd) : signedReturn(entry.returnFraction)}
                          </b>
                          <small className={`pct-pill num ${(sortBy === "pnl" ? entry.returnFraction : entry.pnlUsd) >= 0 ? "up" : "down"}`}>
                            {sortBy === "pnl" ? signedReturn(entry.returnFraction) : signedMoney(entry.pnlUsd)}
                          </small>
                        </span>
                      </a>
                      {me !== entry.owner ? (
                        <FollowButton wallet={entry.owner} following={followed.has(entry.owner)} size="icon" />
                      ) : (
                        <span className="you-tag">You</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </>
      )}

      {board.data?.caveats?.length ? (
        <details className="people-caveats">
          <summary>
            <InfoIcon /> How these numbers work
          </summary>
          {list(board.data.caveats).map((caveat) => (
            <p key={caveat}>{caveat}</p>
          ))}
        </details>
      ) : null}
    </>
  );
}

function Following({ me, onFind }: { me: string; onFind: () => void }) {
  const nameOf = useCompanyName();
  const feed = useAsync<readonly FeedTrade[]>((signal) => api.feed(me, 40, signal).then((r) => r.trades), [me], {
    pollMs: 60_000,
  });
  const following = useAsync<readonly FollowEntry[]>((signal) => api.following(me, signal).then((r) => r.following), [me]);

  if (following.data && following.data.length === 0) {
    return (
      <div className="list-card empty-card">
        <span className="empty-icon" aria-hidden="true">
          <PeopleIcon />
        </span>
        <b>You do not follow anyone yet</b>
        <p>Follow a trader and their trades show up here as they make them.</p>
        <button className="btn-go" onClick={onFind}>
          Find traders to follow
        </button>
      </div>
    );
  }

  return (
    <>
      {following.data ? (
        <section className="list-card">
          <div className="list-card-head">
            <h2>You follow</h2>
            <span>{following.data.length}</span>
          </div>
          <div className="following-strip" aria-label="People you follow">
            {following.data.map((f) => (
              <a key={f.wallet} href={`/traders/${f.wallet}`} onClick={go(`/traders/${f.wallet}`)}>
                <Face wallet={f.wallet} avatar={f.avatar} size={50} />
                <small>{displayName(f.wallet, f.name, f.handle)}</small>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section className="list-card">
        <div className="list-card-head">
          <h2>Their latest trades</h2>
          <span className="live-dot" aria-hidden="true" />
        </div>
        {feed.error ? (
          <p className="positions-empty">Could not load their trades just now.</p>
        ) : !feed.data ? (
          Array.from({ length: 4 }, (_, i) => <span key={i} className="row ghost tall" />)
        ) : feed.data.length === 0 ? (
          <p className="positions-empty">
            The people you follow have not traded since we started watching. Their next trade shows up here.
          </p>
        ) : (
          <div className="rows">
            {feed.data.map((t) => (
              <a
                key={`${t.signature}-${t.symbol}`}
                className="row feed-row"
                href={`/traders/${t.owner}`}
                onClick={go(`/traders/${t.owner}`)}
              >
                <span className="feed-faces">
                  <Face wallet={t.owner} avatar={t.avatar} size={40} />
                  <span className="feed-logo">
                    <TokenLogo symbol={t.symbol} size={22} badge={false} />
                  </span>
                </span>
                <span className="row-main">
                  <b>
                    {displayName(t.owner, t.name, t.handle)}{" "}
                    <span className={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "bought" : "sold"}</span>{" "}
                    {nameOf(t.symbol)}
                  </b>
                  <small className="num">
                    {shares(t.uiAmount)} {t.symbol}
                    {t.blockTime ? ` · ${timeAgo(t.blockTime)}` : ""}
                  </small>
                </span>
                <span className="row-side">
                  <b className="num">{usd(t.valueUsd)}</b>
                </span>
              </a>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function ConnectToFollow() {
  return (
    <div className="list-card empty-card">
      <span className="empty-icon" aria-hidden="true">
        <PeopleIcon />
      </span>
      <b>See what traders do next</b>
      <p>Connect a wallet to follow traders and see their trades here as they make them.</p>
      <div className="inline-picker" style={{ textAlign: "left", width: "100%" }}>
        <WalletPicker />
      </div>
    </div>
  );
}

function timeAgo(unix: number): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - unix));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 11v5M12 8v.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8.5" r="3.3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 19c.6-3.3 2.8-5.2 5.5-5.2s4.9 1.9 5.5 5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.9M17.2 14.2c1.8.6 3 2.2 3.3 4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
