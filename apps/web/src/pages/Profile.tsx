import { useMemo, useState } from "react";
import {
  api,
  type History,
  type HistoryTrade,
  type Intraday,
  type Leaderboard as Board,
  type Market,
  type Portfolio as PortfolioDto,
  type Profile,
  type TraderProfile,
} from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { list, shares, shortAddress, usd, compactCount, displayName, holdWords, monthYear } from "../lib/format.ts";
import { holdingsSeries } from "../lib/series.ts";
import { navigate, go } from "../lib/router.ts";
import { usePhone } from "../lib/phone.ts";
import { useLivePrices } from "../lib/live.ts";
import { signOut, useSignedIn } from "../lib/session.ts";
import { useWallet } from "../features/wallet/WalletContext.tsx";
import { useToast } from "../components/Toast.tsx";
import { useCountUp } from "../lib/motion.ts";
import { TokenLogo } from "../components/TokenLogo.tsx";
import { Trophy, tierOf } from "../features/leaderboard/Trophy.tsx";
import { Segmented } from "../components/Segmented.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { SellButton } from "../features/trade/SellButton.tsx";
import { TradeLauncher } from "../features/trade/TradeLauncher.tsx";
import { WalletPicker } from "../features/wallet/ConnectButton.tsx";
import { TransferSheet } from "../features/wallet/TransferSheet.tsx";
import { useCompanyName } from "../lib/market.ts";
import { ValueChart, type ValuePoint } from "../components/charts/ValueChart.tsx";
import { Cover } from "../features/people/Cover.tsx";
import { EditProfileSheet } from "../features/people/EditProfileSheet.tsx";
import { Face } from "../features/people/Face.tsx";
import { FollowButton } from "../features/people/FollowButton.tsx";
import { FollowListSheet } from "../features/people/FollowListSheet.tsx";
import { MIN_BUY_USD, MIN_SELL_USD } from "../lib/limits.ts";

export const RANGES = [
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 168 },
  { key: "30d", label: "30d", days: 30 },
  { key: "all", label: "All", days: 365 },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

export const RANGE_WORDS: Record<RangeKey, string> = { "24h": "24h", "7d": "7d", "30d": "30d", all: "all time" };

export function MyProfile({ market }: { market: Market | null }) {
  const me = useWallet();
  if (!me.address) return <SignedOut />;
  // Keyed by wallet, so switching accounts in the wallet starts the page
  // clean rather than carrying an open sheet or a range across.
  return <ProfilePage key={me.address} wallet={me.address} market={market} />;
}

function SignedOut() {
  const phone = usePhone();
  return (
    <div className="profile-page">
      <div className="signed-out">
        <span className="face ghost" aria-hidden="true" />
        <h1>{phone ? "Your profile" : "Your dashboard"}</h1>
        <p>Connect a wallet to see what you own, follow traders and share what you hold.</p>
        <div className="inline-picker">
          <WalletPicker />
        </div>
        <a className="text-link" href="/learn" onClick={go("/learn")}>
          New here? How it works
        </a>
      </div>
    </div>
  );
}

export function ProfilePage({ wallet, market }: { wallet: string; market: Market | null }) {
  const me = useWallet();
  const toast = useToast();
  // The desktop sidebar calls the owner's profile the Dashboard, so the page title matches.
  const phone = usePhone();
  const nameOf = useCompanyName();
  const mine = me.address === wallet;

  const [range, setRange] = useState<RangeKey>("24h");
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [sheet, setSheet] = useState<"history" | "settings" | "edit" | "followers" | "following" | "transfer" | null>(
    null,
  );
  const [scrub, setScrub] = useState<ValuePoint | null>(null);
  const [followers, setFollowers] = useState<number | null>(null);

  const profile = useAsync<Profile>(
    (signal) => api.profile(wallet, mine ? null : me.address, signal),
    [wallet, me.address, mine],
  );
  const portfolio = useAsync<PortfolioDto>((signal) => api.portfolio(wallet, signal), [wallet], { pollMs: 30_000 });
  const record = useAsync<TraderProfile>((signal) => api.trader(wallet, 24 * 30, signal), [wallet]);
  const board = useAsync<Board>(
    (signal) => api.leaderboard({ hours: 24 * 30, sortBy: "pnl", limit: 50, minVolumeUsd: 25 }, signal),
    [],
  );
  const intradayFetched = useAsync<Intraday>((signal) => api.intraday(168, signal), [], { pollMs: 5 * 60_000 });
  const historyFetched = useAsync<History>((signal) => api.history(365, signal), []);
  const intraday = { ...intradayFetched, data: useLivePrices(intradayFetched.data, market) };
  const history = { ...historyFetched, data: useLivePrices(historyFetched.data, market) };

  const held = useMemo(() => {
    const out = new Map<string, { uiAmount: number; valueUsd: number; priceUsd: number | null; frozen: boolean; paused: boolean }>();
    for (const p of list(portfolio.data?.positions)) {
      if (p.uiAmount <= 0) continue;
      out.set(p.symbol, { uiAmount: p.uiAmount, valueUsd: p.valueUsd ?? 0, priceUsd: p.priceUsd, frozen: p.frozen, paused: p.paused });
    }
    for (const e of list(portfolio.data?.elsewhere)) {
      const now = out.get(e.symbol);
      out.set(e.symbol, {
        uiAmount: (now?.uiAmount ?? 0) + e.uiAmount,
        valueUsd: (now?.valueUsd ?? 0) + (e.valueUsd ?? 0),
        priceUsd: now?.priceUsd ?? null,
        frozen: now?.frozen ?? false,
        paused: now?.paused ?? false,
      });
    }
    return out;
  }, [portfolio.data]);

  const cash = portfolio.data?.cash.usdcUsd ?? 0;
  const inCompanies = [...held.values()].reduce((sum, h) => sum + h.valueUsd, 0);
  const total = portfolio.data ? inCompanies + cash : null;
  const shownTotal = useCountUp(total);

  const units = useMemo(() => Object.fromEntries([...held].map(([s, h]) => [s, h.uiAmount])), [held]);
  const points = useMemo(
    () => valuePoints(range, units, cash, intraday.data, history.data),
    [range, units, cash, intraday.data, history.data],
  );
  const first = points[0]?.v ?? null;
  const last = points[points.length - 1]?.v ?? null;
  const change = first !== null && last !== null ? last - first : null;
  const changeFraction = change !== null && first ? change / first : null;
  const shownChange = scrub && first !== null ? scrub.v - first : change;
  const shownFraction = scrub && first ? (scrub.v - first) / first : changeFraction;
  const upLine = (change ?? 0) >= 0;
  const spec = RANGES.find((r) => r.key === range)!;
  const chartLoading = held.size > 0 && points.length < 2 && ("hours" in spec ? !intraday.data : !history.data);

  const rank = useMemo(() => {
    const i = list(board.data?.entries).findIndex((e) => e.owner === wallet);
    return i >= 0 ? i + 1 : null;
  }, [board.data, wallet]);

  const books = new Map(list(record.data?.books).map((b) => [b.symbol, b]));
  const changeBySymbol = new Map(list(market?.tokens).map((t) => [t.symbol, t.change24hPct]));

  const openRows = [...held]
    .map(([symbol, h]) => {
      const book = books.get(symbol);
      const known =
        book && book.complete && !book.closed && book.netInvestedUsd > 0 && Math.abs(book.uiAmount - h.uiAmount) <= h.uiAmount * 0.01;
      const pnl = known ? h.valueUsd - book.netInvestedUsd : null;
      return {
        symbol,
        ...h,
        pnl,
        pnlFraction: known && pnl !== null ? pnl / book.netInvestedUsd : null,
        dayPct: changeBySymbol.get(symbol) ?? null,
      };
    })
    .sort((a, b) => b.valueUsd - a.valueUsd);

  const closedRows = list(record.data?.books)
    .filter((b) => b.closed && !held.has(b.symbol))
    .map((b) => ({
      ...b,
      realized: b.complete ? b.soldUsd - b.boughtUsd : null,
      realizedFraction: b.complete && b.boughtUsd > 0 ? (b.soldUsd - b.boughtUsd) / b.boughtUsd : null,
    }))
    .sort((a, b) => Date.parse(b.lastAt ?? "0") - Date.parse(a.lastAt ?? "0"));

  const sellable = openRows.filter((r) => !r.frozen && !r.paused && r.valueUsd >= MIN_SELL_USD);
  const mix = openRows.filter((r) => r.valueUsd > 0);
  const mixTotal = mix.reduce((sum, r) => sum + r.valueUsd, 0);

  const p = profile.data;
  const name = displayName(wallet, p?.name, p?.handle);
  const followerCount = followers ?? p?.followers ?? 0;

  const share = async () => {
    const url = `${window.location.origin}${p?.handle ? `/u/${p.handle}` : `/traders/${wallet}`}`;
    const title = `${name} on Bigsec`;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied", "good");
    } catch {
      toast(url);
    }
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      toast("Address copied", "good");
    } catch {
      toast(wallet);
    }
  };

  const refreshAll = () => {
    portfolio.refresh();
    record.refresh();
    profile.refresh();
  };

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("/traders");
  };

  const icons = (
    <div className="profile-icons">
      <button className="round-btn" onClick={() => void share()} aria-label="Share this profile">
        <ShareIcon />
      </button>
      <button className="round-btn" onClick={() => setSheet("history")} aria-label="Trade history">
        <HistoryIcon />
      </button>
      {mine ? (
        <button className="round-btn" onClick={() => setSheet("settings")} aria-label="Settings">
          <GearIcon />
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="profile-page">
      {mine ? (
        <div className="profile-top">
          <span className="profile-top-title">{phone ? "Profile" : "Dashboard"}</span>
          {icons}
        </div>
      ) : (
        <Cover wallet={wallet}>
          <div className="profile-top over">
            <button className="round-btn glass" onClick={back} aria-label="Back">
              <BackIcon />
            </button>
            {icons}
          </div>
        </Cover>
      )}

      <div className={`profile-id${mine ? "" : " under-cover"}`}>
        <div className="profile-face-row">
          <span className="profile-face">
            <Face wallet={wallet} avatar={p?.avatar} size={phone ? (mine ? 76 : 84) : mine ? 64 : 76} />
            {mine ? (
              <button className="face-edit" onClick={() => setSheet("edit")} aria-label="Change your picture" title="Change your picture" disabled={!p}>
                <CameraIcon />
              </button>
            ) : null}
          </span>
          <div className="profile-actions">
            {mine ? (
              <button className="pill-btn" onClick={() => setSheet("edit")} disabled={!p}>
                Edit profile
              </button>
            ) : (
              <>
                {mix.length > 0 ? (
                  <TradeLauncher
                    className="pill-btn"
                    label="Copy"
                    title={`Copy ${name}`}
                    prompt="How much do you want to put in? You buy the same mix this wallet holds right now, in proportion. It is a one-off copy: it does not follow their future trades, and nothing you already own is sold."
                    weights={mix.map((m) => ({ symbol: m.symbol, weight: mixTotal > 0 ? m.valueUsd / mixTotal : 0 }))}
                    makeRequest={(owner, amountUsd) => ({ kind: "copy", leader: wallet, follower: owner, capitalUsd: amountUsd })}
                  />
                ) : null}
                <FollowButton
                  wallet={wallet}
                  following={p?.viewerFollows ?? false}
                  onChange={(_, count) => {
                    if (count !== null) setFollowers(count);
                    else profile.refresh();
                  }}
                />
              </>
            )}
          </div>
        </div>

        <h1 className="profile-name">{p || profile.error ? name : <span className="shimmer-text">Loading</span>}</h1>
        {/* The address is always here, beside whatever name the wallet gave
            itself; when the title already is the address, this offers to
            copy it rather than saying it twice. */}
        <button className="profile-handle" onClick={() => void copyAddress()} aria-label="Copy wallet address">
          {p?.handle ? <span>@{p.handle}</span> : null}
          {p?.handle || p?.name ? <span className="num">{shortAddress(wallet, 4, 4)}</span> : <span>Copy address</span>}
          <CopyIcon />
        </button>

        {p?.bio ? (
          <p className="profile-bio">{p.bio}</p>
        ) : mine && p ? (
          <button className="add-bio" onClick={() => setSheet("edit")}>
            {p.name || p.handle ? "+ Add a bio" : "+ Add a name and bio"}
          </button>
        ) : null}

        <div className="profile-follows">
          <button onClick={() => setSheet("following")}>
            <b className="num">{compactCount(p?.following ?? 0)}</b> Following
          </button>
          <button onClick={() => setSheet("followers")}>
            <b className="num">{compactCount(followerCount)}</b> {followerCount === 1 ? "Follower" : "Followers"}
          </button>
          {!mine && p?.mutuals ? (
            <span>
              Followed by <b className="num">{p.mutuals}</b> you follow
            </span>
          ) : null}
          {!mine && p?.followsViewer ? <span className="follows-you">Follows you</span> : null}
        </div>

        <div className="profile-stats">
          {rank ? (
            <span className={`stat-chip rank${rank <= 3 ? ` ${tierOf(rank)}` : ""}`}>
              {rank === 1 || rank === 2 || rank === 3 ? <Trophy rank={rank} size={20} /> : <TrophyIcon />} #{rank}{" "}
              <small>30 days</small>
            </span>
          ) : null}
          <span className="stat-chip">
            <ClockIcon />
            {p?.activity.avgHoldSeconds != null ? `${holdWords(p.activity.avgHoldSeconds)} avg. hold` : "No hold time"}
          </span>
          <span className="stat-chip">
            <BarsIcon />
            {compactCount(p?.activity.trades ?? 0)} {(p?.activity.trades ?? 0) === 1 ? "trade" : "trades"}
          </span>
          {p?.joinedAt ? (
            <span className="stat-chip">
              <CalendarIcon /> Joined {monthYear(p.joinedAt)}
            </span>
          ) : p?.activity.firstTradeAt ? (
            <span className="stat-chip">
              <CalendarIcon /> Since {monthYear(p.activity.firstTradeAt)}
            </span>
          ) : null}
        </div>
      </div>

      <section className="profile-value" aria-label="Value">
        {portfolio.error && !portfolio.data ? (
          <p className="note">Could not read this wallet just now. It will retry on its own.</p>
        ) : (
          <>
            <div className="value-figure num">
              {total === null ? <span className="shimmer-text">$0.00</span> : usd(scrub ? scrub.v : shownTotal)}
            </div>
            <div className="value-change">
              {scrub ? (
                <span className="muted">{scrubLabel(scrub.t, range)}</span>
              ) : null}
              {shownChange !== null && held.size > 0 ? (
                <span className={`num ${Math.abs(shownChange) < 0.005 ? "muted" : shownChange > 0 ? "up" : "down"}`}>
                  {signedUsd(shownChange)} ({signedPct(shownFraction)})
                </span>
              ) : null}
              {!scrub && held.size > 0 ? <span className="muted">{RANGE_WORDS[range]}</span> : null}
            </div>
            <ValueChart
              points={points}
              up={upLine}
              height={176}
              onScrub={setScrub}
              empty={
                !portfolio.data || chartLoading ? (
                  <span className="shimmer" style={{ display: "block", height: "100%", width: "100%" }} />
                ) : (
                  <span className="value-empty">{mine ? "No positions yet" : "No positions right now"}</span>
                )
              }
            />
            <Segmented
              className="pill-seg"
              label="Time range"
              options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
              value={range}
              onChange={setRange}
            />
            {held.size > 0 ? (
              <p className="value-note">{mine ? "What you hold now" : "What they hold now"}, at past prices.</p>
            ) : null}
            <div className="value-cash">
              <span>
                <small>Cash (USDC)</small>
                <b className="num">{portfolio.data ? usd(cash) : "—"}</b>
              </span>
              <span>
                <small>In companies</small>
                <b className="num">{portfolio.data ? usd(inCompanies) : "—"}</b>
              </span>
              {mine ? (
                <span>
                  <small>SOL for fees</small>
                  <b className="num">{portfolio.data ? (portfolio.data.cash.solLamports / 1e9).toFixed(4) : "—"}</b>
                </span>
              ) : null}
            </div>
          </>
        )}
      </section>

      {mine && portfolio.data ? <Warnings data={portfolio.data} /> : null}

      <section className="profile-positions">
        <div className="positions-head">
          <h2>
            Positions <span className="num">({tab === "open" ? openRows.length : closedRows.length})</span>
          </h2>
          <Segmented
            className="pill-seg small"
            label="Open or closed positions"
            options={[
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>

        {tab === "open" ? (
          !portfolio.data ? (
            <div className="shimmer" style={{ height: 150 }} />
          ) : openRows.length === 0 ? (
            <p className="positions-empty">
              {mine ? "You do not own any of these companies yet." : "This wallet holds none of these companies right now."}
            </p>
          ) : (
            <div className="rows">
              {openRows.map((row) => {
                const page = `/companies/${row.symbol.toLowerCase()}`;
                const pnlTone = row.pnl === null ? "" : Math.abs(row.pnl) < 0.005 ? "muted" : row.pnl > 0 ? "up" : "down";
                const dayTone = row.dayPct == null ? "muted" : row.dayPct >= 0 ? "up" : "down";
                return (
                  <a key={row.symbol} className="row" href={page} onClick={go(page)}>
                    <TokenLogo symbol={row.symbol} size={42} />
                    <span className="row-main">
                      <b>{nameOf(row.symbol)}</b>
                      <small className="num">
                        {shares(row.uiAmount)} {row.symbol}
                        {row.frozen ? " · frozen" : row.paused ? " · paused" : ""}
                      </small>
                    </span>
                    <span className="row-side">
                      <b className="num">{usd(row.valueUsd)}</b>
                      {row.pnl !== null ? (
                        <small className={`num ${pnlTone}`}>
                          {signedUsd(row.pnl)} · {signedPct(row.pnlFraction)}
                        </small>
                      ) : (
                        <small className={`num ${dayTone}`}>
                          {row.dayPct == null ? "—" : `${row.dayPct >= 0 ? "+" : ""}${row.dayPct.toFixed(2)}%`} <em>24h</em>
                        </small>
                      )}
                    </span>
                  </a>
                );
              })}
            </div>
          )
        ) : !record.data ? (
          record.error ? (
            <p className="positions-empty">Could not load the record just now.</p>
          ) : (
            <div className="shimmer" style={{ height: 120 }} />
          )
        ) : closedRows.length === 0 ? (
          <p className="positions-empty">
            {mine ? "Nothing sold out yet." : "No closed positions we have seen."} Positions closed through trades we saw
            show here with what they made.
          </p>
        ) : (
          <div className="rows">
            {closedRows.map((row) => (
              <a key={row.symbol} className="row" href={`/companies/${row.symbol.toLowerCase()}`} onClick={go(`/companies/${row.symbol.toLowerCase()}`)}>
                <TokenLogo symbol={row.symbol} size={42} />
                <span className="row-main">
                  <b>{nameOf(row.symbol)}</b>
                  <small>
                    Sold out{row.lastAt ? ` · ${new Date(row.lastAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""} ·{" "}
                    {row.trades} {row.trades === 1 ? "trade" : "trades"}
                  </small>
                </span>
                <span className="row-side">
                  {row.realized === null ? (
                    <>
                      <b className="muted">—</b>
                      <small className="muted">partial record</small>
                    </>
                  ) : (
                    <>
                      <b className={`num ${row.realized >= 0 ? "up" : "down"}`}>{signedUsd(row.realized)}</b>
                      <small className={`num ${row.realized >= 0 ? "up" : "down"}`}>{signedPct(row.realizedFraction)}</small>
                    </>
                  )}
                </span>
              </a>
            ))}
          </div>
        )}

        <div className="profile-cta">
          {mine ? (
            <>
              {cash < MIN_BUY_USD ? (
                <button className="btn-go" onClick={() => setSheet("transfer")}>
                  Deposit
                </button>
              ) : (
                <a className="btn-go" href="/companies" onClick={go("/companies")}>
                  {openRows.length ? "Buy more" : "Buy your first company"}
                </a>
              )}
              {sellable.length > 1 ? (
                <SellButton name="everything" label="Sell everything" className="btn-soft" onSettled={refreshAll} />
              ) : null}
            </>
          ) : mix.length > 0 ? (
            <TradeLauncher
              className="btn-go"
              label="Copy this mix"
              title={`Copy ${name}`}
              prompt="How much do you want to put in? You buy the same mix this wallet holds right now, in proportion. It is a one-off copy: it does not follow their future trades, and nothing you already own is sold."
              weights={mix.map((m) => ({ symbol: m.symbol, weight: mixTotal > 0 ? m.valueUsd / mixTotal : 0 }))}
              makeRequest={(owner, amountUsd) => ({ kind: "copy", leader: wallet, follower: owner, capitalUsd: amountUsd })}
            />
          ) : null}
        </div>
        {!mine && record.data && record.data.trades > 0 ? (
          <p className="value-note" style={{ textAlign: "center" }}>
            Profit counts only trades made since we started watching the market. Past results say little about what
            comes next.
          </p>
        ) : null}
      </section>

      {sheet === "history" ? <HistorySheet wallet={wallet} mine={mine} onClose={() => setSheet(null)} /> : null}
      {sheet === "followers" || sheet === "following" ? (
        <FollowListSheet wallet={wallet} initial={sheet} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === "edit" && p ? (
        <EditProfileSheet profile={p} onClose={() => setSheet(null)} onSaved={profile.refresh} />
      ) : null}
      {sheet === "settings" ? (
        <SettingsSheet
          wallet={wallet}
          onClose={() => setSheet(null)}
          onEdit={() => setSheet("edit")}
          onCopy={() => void copyAddress()}
        />
      ) : null}
      {sheet === "transfer" ? <TransferSheet onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

export function valuePoints(
  range: RangeKey,
  units: Record<string, number>,
  cash: number,
  intraday: Intraday | null,
  history: History | null,
): ValuePoint[] {
  if (Object.keys(units).length === 0) return [];
  const spec = RANGES.find((r) => r.key === range)!;
  if ("hours" in spec) {
    if (!intraday) return [];
    const from = Math.max(0, intraday.times.length - spec.hours - 1);
    const times = intraday.times.slice(from);
    const prices: Record<string, (number | null)[]> = {};
    for (const [symbol, series] of Object.entries(intraday.prices)) prices[symbol] = series.slice(from);
    const values = holdingsSeries({ days: times.map(String), prices }, units);
    return times.flatMap((t, i) => (values[i] == null ? [] : [{ t: t * 1000, v: values[i]! + cash }]));
  }
  if (!history) return [];
  const from = Math.max(0, history.days.length - spec.days - 1);
  const days = history.days.slice(from);
  const prices: Record<string, (number | null)[]> = {};
  for (const [symbol, series] of Object.entries(history.prices)) prices[symbol] = series.slice(from);
  const values = holdingsSeries({ days, prices }, units);
  const lastDay = days.length - 1;
  return days.flatMap((day, i) =>
    values[i] == null
      ? []
      : [{ t: i === lastDay ? Date.parse(history.asOf) : Date.parse(`${day}T00:00:00Z`), v: values[i]! + cash }],
  );
}

const HOUR = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function scrubLabel(t: number, range: RangeKey): string {
  return range === "24h" || range === "7d" ? HOUR.format(new Date(t)) : DAY.format(new Date(t));
}

function signedUsd(value: number): string {
  if (Math.abs(value) < 0.005) return usd(0);
  return `${value > 0 ? "+" : "−"}${usd(Math.abs(value))}`;
}

function signedPct(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  const pct = fraction * 100;
  if (Math.abs(pct) < 0.005) return "0.00%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`;
}

function Warnings({ data }: { data: PortfolioDto }) {
  const frozen = list(data.frozen);
  const elsewhere = list(data.elsewhere);
  const unpriced = list(data.unpriced);
  if (data.cash.canPayFees && !frozen.length && !elsewhere.length && !unpriced.length) return null;
  return (
    <div className="profile-warnings">
      {!data.cash.canPayFees ? (
        <p className="banner bad">This wallet needs a little SOL (about 0.02) to pay network fees before it can buy or sell.</p>
      ) : null}
      {frozen.length ? (
        <p className="banner bad">
          The issuer has frozen {frozen.join(", ")} in this wallet. It still counts, but cannot be sold until it is unfrozen.
        </p>
      ) : null}
      {elsewhere.length ? (
        <p className="banner">
          Some of what you hold sits in other token accounts ({elsewhere.map((e) => e.symbol).join(", ")}). It counts
          toward your total, but move it to your wallet's main account for that token before selling it here.
        </p>
      ) : null}
      {unpriced.length ? (
        <p className="banner bad">No price for {unpriced.join(", ")} just now, so it shows as $0. Try again in a minute.</p>
      ) : null}
    </div>
  );
}

function HistorySheet({ wallet, mine, onClose }: { wallet: string; mine: boolean; onClose: () => void }) {
  const nameOf = useCompanyName();
  const trades = useAsync<readonly HistoryTrade[]>(
    (signal) => api.traderTrades(wallet, 100, signal).then((r) => r.trades),
    [wallet],
  );
  return (
    <Sheet title={mine ? "Your trades" : "Their trades"} onClose={onClose}>
      {trades.error ? (
        <p className="note">Could not load the history just now.</p>
      ) : !trades.data ? (
        <div className="shimmer" style={{ height: 200 }} />
      ) : trades.data.length === 0 ? (
        <p className="note" style={{ padding: "14px 2px" }}>
          No trades seen yet. We record trades on these companies from the moment we started watching the market; a
          trade made here shows up within a minute or two.
        </p>
      ) : (
        <div className="rows">
          {trades.data.map((t) => (
            <a
              key={`${t.signature}-${t.symbol}`}
              className="row"
              href={`https://solscan.io/tx/${t.signature}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              <TokenLogo symbol={t.symbol} size={38} />
              <span className="row-main">
                <b>
                  {t.side === "buy" ? "Bought" : "Sold"} {nameOf(t.symbol)}
                </b>
                <small className="num">
                  {shares(t.uiAmount)} {t.symbol}
                  {t.at ? ` · ${new Date(t.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                </small>
              </span>
              <span className="row-side">
                <b className={`num ${t.side === "buy" ? "" : "up"}`}>
                  {t.valueUsd === null ? "—" : `${t.side === "buy" ? "−" : "+"}${usd(t.valueUsd)}`}
                </b>
                <small className="muted">Solscan ↗</small>
              </span>
            </a>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function SettingsSheet({
  wallet,
  onClose,
  onEdit,
  onCopy,
}: {
  wallet: string;
  onClose: () => void;
  onEdit: () => void;
  onCopy: () => void;
}) {
  const me = useWallet();
  const toast = useToast();
  const signedIn = useSignedIn(wallet);
  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="menu-list">
        <button className="menu-item" onClick={onEdit}>
          Edit profile
        </button>
        <button className="menu-item" onClick={onCopy}>
          Copy wallet address
        </button>
        <a className="menu-item" href={`https://solscan.io/account/${wallet}`} target="_blank" rel="noreferrer noopener">
          See this wallet on Solscan ↗
        </a>
        <a
          className="menu-item"
          href="/learn"
          onClick={(event) => {
            onClose();
            go("/learn")(event);
          }}
        >
          How it works, costs and risks
        </a>
        {signedIn ? (
          <button
            className="menu-item"
            onClick={() => {
              void signOut(wallet).then(() => toast("Signed out of your profile on this device"));
            }}
          >
            Sign out of profile
            <small>Following and edits will ask your wallet to sign in again.</small>
          </button>
        ) : null}
        <button
          className="menu-item danger"
          onClick={() => {
            onClose();
            void me.disconnect();
          }}
        >
          Disconnect {me.walletName ?? "wallet"}
        </button>
      </div>
    </Sheet>
  );
}

const stroke = { stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function ShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5v11M8 7.5l4-4 4 4" {...stroke} />
      <path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v6A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H16" {...stroke} />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7" {...stroke} />
      <path d="M12 8v4.3l2.8 1.7" {...stroke} />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" {...stroke} />
      <path
        d="M19 13.5v-3l-2.1-.5a5.6 5.6 0 0 0-.6-1.4l1.1-1.9-2.1-2.1-1.9 1.1a5.6 5.6 0 0 0-1.4-.6L11.5 3h-3l-.5 2.1a5.6 5.6 0 0 0-1.4.6L4.7 4.6 2.6 6.7l1.1 1.9a5.6 5.6 0 0 0-.6 1.4L1 10.5v3l2.1.5c.1.5.3 1 .6 1.4l-1.1 1.9 2.1 2.1 1.9-1.1c.4.3.9.5 1.4.6l.5 2.1h3l.5-2.1c.5-.1 1-.3 1.4-.6l1.9 1.1 2.1-2.1-1.1-1.9c.3-.4.5-.9.6-1.4l2.1-.5Z"
        transform="translate(2 0) scale(0.92)"
        {...stroke}
      />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" {...stroke} strokeWidth={2.2} />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2.5" {...stroke} strokeWidth={2} />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" {...stroke} strokeWidth={2} />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" {...stroke} strokeWidth={2} />
      <path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3.5M8.5 20.5h7" {...stroke} strokeWidth={2} />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" {...stroke} strokeWidth={2} />
      <path d="M12 7.5V12l3 2" {...stroke} strokeWidth={2} />
    </svg>
  );
}

function BarsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 19v-6M10 19V9M15 19v-9M20 19V5" {...stroke} strokeWidth={2.2} />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" {...stroke} strokeWidth={2} />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" {...stroke} strokeWidth={2} />
    </svg>
  );
}
