/**
 * Desktop layout: a header with brand, search and account, and a grouped
 * section list down the left that ends with the price feed status.
 */

import { useState } from "react";
import { api, type Portfolio } from "../lib/api.ts";
import { list, usd } from "../lib/format.ts";
import { useAsync } from "../lib/useAsync.ts";
import { go } from "../lib/router.ts";
import { SearchBox } from "../components/SearchBox.tsx";
import { ConnectButton } from "../features/wallet/ConnectButton.tsx";
import { TransferSheet } from "../features/wallet/TransferSheet.tsx";
import { useWallet } from "../features/wallet/WalletContext.tsx";

interface Section {
  readonly href: string;
  readonly label: string;
  readonly icon: () => React.ReactNode;
  /** Older paths that land on the same page. */
  readonly also: readonly string[];
}

const GROUPS: readonly { readonly label: string | null; readonly sections: readonly Section[] }[] = [
  {
    label: null,
    sections: [
      { href: "/dashboard", label: "Explore", icon: ExploreIcon, also: ["/explore"] },
      { href: "/portfolio", label: "Dashboard", icon: DashboardIcon, also: [] },
    ],
  },
  {
    label: "Markets",
    sections: [
      { href: "/companies", label: "Companies", icon: CompaniesIcon, also: ["/assets"] },
      { href: "/baskets", label: "Baskets", icon: BasketIcon, also: ["/indexes"] },
    ],
  },
  {
    label: "Community",
    sections: [
      { href: "/traders", label: "Leaderboard", icon: TrophyNavIcon, also: ["/leaderboard"] },
      { href: "/build", label: "Create a basket", icon: CreateIcon, also: ["/compose"] },
    ],
  },
];

/** The header and the sidebar, sharing one read of what the wallet holds. */
export function DeskFrame({ path }: { path: string }) {
  const wallet = useWallet();
  const portfolio = useAsync<Portfolio | null>(
    (signal) => (wallet.address ? api.portfolio(wallet.address, signal) : Promise.resolve(null)),
    [wallet.address],
    { pollMs: 60_000 },
  );
  const data = portfolio.data;
  // Everything the wallet holds here: the companies, wherever they sit, and cash.
  const total = data
    ? data.totalUsd + list(data.elsewhere).reduce((sum, e) => sum + (e.valueUsd ?? 0), 0) + data.cash.usdcUsd
    : null;
  return (
    <>
      <TopBar total={total} />
      <SideBar path={path} />
    </>
  );
}

function TopBar({ total }: { total: number | null }) {
  const wallet = useWallet();
  const [transfer, setTransfer] = useState(false);
  return (
    <header className="topbar">
      <a className="topbar-brand" href="/" onClick={go("/")} aria-label="BasketX home">
        <span className="topbar-mark" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
            <rect x="1" y="3" width="16" height="3" rx="1.5" fill="currentColor" />
            <rect x="1" y="7.5" width="11" height="3" rx="1.5" fill="currentColor" opacity="0.72" />
            <rect x="1" y="12" width="6.5" height="3" rx="1.5" fill="currentColor" opacity="0.44" />
          </svg>
        </span>
        <b>BasketX</b>
      </a>
      <div className="topbar-search">
        <SearchBox />
      </div>
      <div className="topbar-right">
        {wallet.address ? (
          <>
            <a className="topbar-total" href="/portfolio" onClick={go("/portfolio")} title="What this wallet holds here">
              <small>Total value</small>
              <b className="num">{total === null ? "—" : usd(total)}</b>
            </a>
            <button className="btn-mint topbar-deposit" onClick={() => setTransfer(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
              Deposit
            </button>
          </>
        ) : null}
        <ConnectButton />
      </div>
      {transfer ? <TransferSheet onClose={() => setTransfer(false)} /> : null}
    </header>
  );
}

function SideBar({ path }: { path: string }) {
  const wallet = useWallet();
  const mine = wallet.address ? `/traders/${wallet.address}` : null;
  const here = (section: Section) =>
    path === section.href ||
    path.startsWith(`${section.href}/`) ||
    section.also.some((a) => path === a || path.startsWith(`${a}/`)) ||
    (section.href === "/portfolio" && mine !== null && path === mine);

  return (
    <nav className="sidenav" aria-label="Sections">
      <div className="sidenav-groups">
        {GROUPS.map((group) => (
          <div key={group.label ?? "top"} className="sidenav-group">
            {group.label ? <p className="sidenav-label">{group.label}</p> : null}
            {group.sections.map((section) => (
              <a
                key={section.href}
                className="sidenav-item"
                href={section.href}
                onClick={go(section.href)}
                aria-current={here(section) ? "page" : undefined}
              >
                <section.icon />
                <span>{section.label}</span>
              </a>
            ))}
          </div>
        ))}
      </div>
      <div className="sidenav-foot">
        <div className="sidenav-group">
          <a className="sidenav-item" href="/learn" onClick={go("/learn")} aria-current={path === "/learn" ? "page" : undefined}>
            <HelpIcon />
            <span>How it works</span>
          </a>
          <a className="sidenav-item" href="/search" onClick={go("/search")} aria-current={path === "/search" ? "page" : undefined}>
            <SearchIcon />
            <span>Search</span>
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ icons */

const stroke = { stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="8" rx="1.6" {...stroke} />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.6" {...stroke} />
      <rect x="3.5" y="14.5" width="7" height="6" rx="1.6" {...stroke} />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.6" {...stroke} />
    </svg>
  );
}

function ExploreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" {...stroke} />
      <path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5 4.5-1.9Z" {...stroke} />
    </svg>
  );
}

function CompaniesIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 17 9 11.5l3.5 3.5 8-8" {...stroke} />
      <path d="M15.5 7h5v5" {...stroke} />
    </svg>
  );
}

function BasketIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M19.4 14A7.8 7.8 0 1 1 10 4.6" {...stroke} />
      <path d="M13.2 3.6a7.2 7.2 0 0 1 7.2 7.2h-7.2V3.6Z" {...stroke} />
    </svg>
  );
}

function TrophyNavIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7.5 4.5h9v4.8a4.5 4.5 0 0 1-9 0V4.5Z" {...stroke} />
      <path d="M7.5 6.5H5.2c0 2.6 1.1 4.2 2.9 4.7M16.5 6.5h2.3c0 2.6-1.1 4.2-2.9 4.7M12 13.8v3.4M8.5 20h7M9.8 17.2h4.4" {...stroke} />
    </svg>
  );
}

function CreateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" {...stroke} />
      <path d="M12 8.5v7M8.5 12h7" {...stroke} />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" {...stroke} />
      <path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.4M12 16.6v.1" {...stroke} />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" {...stroke} />
      <path d="m16 16 4 4" {...stroke} />
    </svg>
  );
}
