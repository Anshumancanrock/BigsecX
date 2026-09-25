import { useEffect, useMemo, useRef, useState } from "react";
import { api, type IndexList, type StrategyDto } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { ADDRESS_PATTERN, list, price, shortAddress } from "../lib/format.ts";
import { useMarket } from "../lib/market.ts";

const PAGES = [
  { label: "How it works, costs and risks", href: "/learn", words: "how it works learn help risk fee cost faq" },
  { label: "Build your own basket", href: "/build", words: "build create make basket publish" },
  { label: "What I own", href: "/portfolio", words: "portfolio what i own holdings sell balance" },
  { label: "Traders", href: "/traders", words: "traders leaderboard copy follow" },
] as const;

interface Result {
  readonly group: string;
  readonly label: string;
  readonly detail: string;
  readonly href: string;
}

export function SearchBox() {
  const market = useMarket();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [baskets, setBaskets] = useState<{ indexes: IndexList["indexes"]; strategies: readonly StrategyDto[] } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // "/" jumps to the search box from anywhere, as on most sites with one,
  // unless the key is being typed into a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open || baskets) return;
    let live = true;
    Promise.all([api.indexes().catch(() => null), api.strategies().catch(() => null)]).then(([i, s]) => {
      if (live) setBaskets({ indexes: list(i?.indexes), strategies: list(s?.strategies) });
    });
    return () => {
      live = false;
    };
  }, [open, baskets]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hit = (text: string) =>
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((word) => word.startsWith(q)) || (q.length >= 3 && text.toLowerCase().includes(q));
    const out: Result[] = [];
    if (ADDRESS_PATTERN.test(query.trim())) {
      out.push({
        group: "Wallet",
        label: `Look up ${shortAddress(query.trim(), 6, 6)}`,
        detail: "See what it holds and copy it",
        href: `/traders/${query.trim()}`,
      });
    }
    for (const t of list(market?.tokens)) {
      if (hit(t.name) || hit(t.symbol)) {
        out.push({ group: "Companies", label: t.name, detail: price(t.marketUsd), href: `/companies/${t.symbol.toLowerCase()}` });
      }
    }
    for (const b of list(baskets?.indexes)) {
      if (hit(b.name)) {
        out.push({ group: "Baskets", label: b.name, detail: `${list(b.weights).length} companies`, href: `/baskets/${b.id}` });
      }
    }
    for (const s of list(baskets?.strategies)) {
      if (hit(s.name)) {
        out.push({ group: "Baskets", label: s.name, detail: `by ${shortAddress(s.creator, 4, 4)}`, href: `/baskets/${s.id}` });
      }
    }
    for (const page of PAGES) {
      if (hit(page.words) || hit(page.label)) {
        out.push({ group: "Pages", label: page.label, detail: "", href: page.href });
      }
    }
    return out.slice(0, 9);
  }, [query, market, baskets]);

  const go = (result: Result | undefined) => {
    if (!result) return;
    navigate(result.href);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="search" ref={box}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="6.2" stroke="currentColor" strokeWidth="1.5" />
        <path d="m13.7 13.7 3.6 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        ref={input}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setCursor((c) => Math.min(results.length - 1, c + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (event.key === "Enter") {
            go(results[cursor]);
          } else if (event.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
        placeholder="Type to search…"
        aria-label="Search companies, baskets and wallets"
        spellCheck={false}
        autoComplete="off"
      />
      {!query ? (
        <kbd className="search-key" aria-hidden="true">
          /
        </kbd>
      ) : null}

      {open && query.trim() ? (
        <div className="search-menu" role="listbox">
          {results.length === 0 ? (
            <div className="search-empty">Nothing matches “{query.trim()}”. Try a company name, or paste a wallet address.</div>
          ) : (
            results.map((result, i) => (
              <button
                key={`${result.group}-${result.href}`}
                className={`search-row${i === cursor ? " active" : ""}`}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(result)}
              >
                <span className="search-group">{result.group}</span>
                <span className="search-label">{result.label}</span>
                <span className="search-detail num">{result.detail}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
