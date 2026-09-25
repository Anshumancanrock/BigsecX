import { useEffect, useMemo, useRef, useState } from "react";
import { api, type IndexList, type Leaderboard as Board, type Market, type StrategyDto } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { ADDRESS_PATTERN, displayName, list, shortAddress } from "../lib/format.ts";
import { navigate, go } from "../lib/router.ts";
import { TokenLogo } from "../components/TokenLogo.tsx";
import { CompanyRow } from "../components/CompanyRow.tsx";
import { Face } from "../features/people/Face.tsx";

const HANDLE = /^@?[A-Za-z0-9_]{3,20}$/;

export function Search({ market }: { market: Market | null }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const indexes = useAsync<IndexList>((signal) => api.indexes(signal), []);
  const strategies = useAsync<readonly StrategyDto[]>((signal) => api.strategies(signal).then((r) => r.strategies), []);
  const board = useAsync<Board>(
    (signal) => api.leaderboard({ hours: 24 * 30, sortBy: "pnl", limit: 20, minVolumeUsd: 25 }, signal),
    [],
  );

  useEffect(() => {
    if (typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, []);

  const q = query.trim().toLowerCase().replace(/^@/, "");
  const hit = (text: string) =>
    !q ||
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((word) => word.startsWith(q)) ||
    (q.length >= 3 && text.toLowerCase().includes(q));

  const handleQuery = HANDLE.test(query.trim()) && !ADDRESS_PATTERN.test(query.trim()) ? q : null;
  const [handleHit, setHandleHit] = useState<{ handle: string; wallet: string; avatar: string | null } | null>(null);
  useEffect(() => {
    setHandleHit(null);
    if (!handleQuery) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .handle(handleQuery, controller.signal)
        .then((r) => setHandleHit({ handle: r.handle, wallet: r.wallet, avatar: r.avatar ?? null }))
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [handleQuery]);

  const companies = useMemo(
    () =>
      list(market?.tokens)
        .filter((t) => hit(t.name) || hit(t.symbol))
        .slice()
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [market, q],
  );
  const baskets = [
    ...list(indexes.data?.indexes)
      .filter((b) => list(b.weights).length > 0 && hit(b.name))
      .map((b) => ({ id: b.id, name: b.name, detail: `${list(b.weights).length} companies`, symbols: list(b.weights).map((w) => w.symbol) })),
    ...list(strategies.data)
      .filter((s) => hit(s.name))
      .map((s) => ({ id: s.id, name: s.name, detail: `by ${shortAddress(s.creator, 4, 4)}`, symbols: s.weights.map((w) => w.symbol) })),
  ].slice(0, q ? 8 : 5);
  const traders = list(board.data?.entries)
    .filter((e) => hit(e.name ?? "") || hit(e.handle ?? "") || (q.length >= 4 && e.owner.toLowerCase().startsWith(q)))
    .slice(0, q ? 8 : 5);

  const address = ADDRESS_PATTERN.test(query.trim()) ? query.trim() : null;
  const nothing = q && !address && !handleHit && companies.length === 0 && baskets.length === 0 && traders.length === 0;

  return (
    <div className="find-page">
      <form
        className="find-field"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (address) navigate(`/traders/${address}`);
          else if (handleHit) navigate(`/traders/${handleHit.wallet}`);
          else if (companies[0]) navigate(`/companies/${companies[0].symbol.toLowerCase()}`);
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Companies, baskets, @people, wallets"
          aria-label="Search companies, baskets, people and wallets"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          enterKeyHint="search"
        />
        {query ? (
          <button type="button" className="find-clear" onClick={() => setQuery("")} aria-label="Clear">
            ×
          </button>
        ) : null}
      </form>

      {address ? (
        <Group title="Wallet">
          <a className="row" href={`/traders/${address}`} onClick={go(`/traders/${address}`)}>
            <Face wallet={address} size={42} />
            <span className="row-main">
              <b className="num">{shortAddress(address, 6, 6)}</b>
              <small>See what it holds, follow it or copy it</small>
            </span>
          </a>
        </Group>
      ) : null}

      {handleHit && !traders.some((t) => t.owner === handleHit.wallet) ? (
        <Group title="People">
          <a className="row" href={`/traders/${handleHit.wallet}`} onClick={go(`/traders/${handleHit.wallet}`)}>
            <Face wallet={handleHit.wallet} avatar={handleHit.avatar} size={42} />
            <span className="row-main">
              <b>@{handleHit.handle}</b>
              <small className="num">{shortAddress(handleHit.wallet, 4, 4)}</small>
            </span>
          </a>
        </Group>
      ) : null}

      {companies.length ? (
        <Group title="Companies">
          {companies.map((t) => (
            <CompanyRow key={t.mint} token={t} />
          ))}
        </Group>
      ) : null}

      {baskets.length ? (
        <Group title="Baskets" more={q ? undefined : { href: "/baskets", label: "All baskets" }}>
          {baskets.map((b) => (
            <a key={b.id} className="row" href={`/baskets/${b.id}`} onClick={go(`/baskets/${b.id}`)}>
              <span className="basket-logos" aria-hidden="true">
                {b.symbols.slice(0, 3).map((symbol) => (
                  <TokenLogo key={symbol} symbol={symbol} size={26} badge={false} />
                ))}
              </span>
              <span className="row-main">
                <b>{b.name}</b>
                <small>{b.detail}</small>
              </span>
            </a>
          ))}
        </Group>
      ) : null}

      {traders.length ? (
        <Group title={q ? "People" : "Top traders"} more={q ? undefined : { href: "/traders", label: "Leaderboard" }}>
          {traders.map((t) => (
            <a key={t.owner} className="row" href={`/traders/${t.owner}`} onClick={go(`/traders/${t.owner}`)}>
              <Face wallet={t.owner} avatar={t.avatar} size={42} />
              <span className="row-main">
                <b>{displayName(t.owner, t.name, t.handle)}</b>
                <small className="num">
                  {t.handle ? `@${t.handle} · ` : ""}
                  {shortAddress(t.owner, 4, 4)}
                </small>
              </span>
              <span className="row-side">
                <b className={`num ${t.returnFraction >= 0 ? "up" : "down"}`}>
                  {t.returnFraction >= 0 ? "+" : "−"}
                  {Math.abs(t.returnFraction * 100).toFixed(1)}%
                </b>
                <small className="muted">30 days</small>
              </span>
            </a>
          ))}
        </Group>
      ) : null}

      {nothing ? (
        <p className="positions-empty">
          Nothing matches “{query.trim()}”. Try a company name, a @username, or paste a wallet address.
        </p>
      ) : null}

      {!q ? (
        <Group title="Pages">
          <a className="row more" href="/learn" onClick={go("/learn")}>
            <span className="row-main">
              <b>How it works, costs and risks</b>
            </span>
          </a>
          <a className="row more" href="/build" onClick={go("/build")}>
            <span className="row-main">
              <b>Build your own basket</b>
            </span>
          </a>
        </Group>
      ) : null}
    </div>
  );
}

function Group({
  title,
  more,
  children,
}: {
  title: string;
  more?: { href: string; label: string } | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className="find-group">
      <div className="find-group-head">
        <h2>{title}</h2>
        {more ? (
          <a href={more.href} onClick={go(more.href)}>
            {more.label}
          </a>
        ) : null}
      </div>
      <div className="rows">{children}</div>
    </section>
  );
}
