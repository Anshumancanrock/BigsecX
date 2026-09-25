import { go } from "../lib/router.ts";
import { useWallet } from "../features/wallet/WalletContext.tsx";
import { Face } from "../features/people/Face.tsx";

const stroke = { stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const TABS = [
  { href: "/dashboard", label: "Home", also: ["/explore"], icon: HomeIcon },
  { href: "/search", label: "Search", also: [], icon: SearchIcon },
  { href: "/baskets", label: "Baskets", also: ["/indexes", "/build"], icon: null },
  { href: "/traders", label: "Leaderboard", also: ["/leaderboard"], icon: TrophyTabIcon },
  { href: "/portfolio", label: "You", also: [], icon: null },
] as const;

export function TabBar({ path }: { path: string }) {
  const wallet = useWallet();
  const mine = wallet.address ? `/traders/${wallet.address}` : null;

  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map((tab) => {
        const here =
          path === tab.href ||
          path.startsWith(`${tab.href}/`) ||
          (tab.also as readonly string[]).some((a) => path === a || path.startsWith(`${a}/`)) ||
          (tab.href === "/portfolio" && mine !== null && path === mine) ||
          (tab.href === "/dashboard" && (path.startsWith("/companies") || path === "/learn"));
        const Icon = tab.icon;
        return (
          <a
            key={tab.href}
            className={`tab${tab.href === "/baskets" ? " tab-mark" : ""}`}
            href={tab.href}
            onClick={go(tab.href)}
            aria-label={tab.label}
            aria-current={here ? "page" : undefined}
          >
            {tab.href === "/baskets" ? (
              <span className="tab-mark-disc">
                <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <rect x="1" y="3" width="16" height="3" rx="1.5" fill="currentColor" />
                  <rect x="1" y="7.5" width="11" height="3" rx="1.5" fill="currentColor" opacity="0.72" />
                  <rect x="1" y="12" width="6.5" height="3" rx="1.5" fill="currentColor" opacity="0.44" />
                </svg>
              </span>
            ) : tab.href === "/portfolio" ? (
              wallet.address ? (
                <span className="tab-face">
                  <Face wallet={wallet.address} size={28} />
                </span>
              ) : (
                <YouIcon />
              )
            ) : Icon ? (
              <Icon />
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

function HomeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 10.2 12 4l8 6.2V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.8Z" {...stroke} />
      <path d="M9.5 20.5v-5.5h5v5.5" {...stroke} />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" {...stroke} />
      <path d="m16 16 4 4" {...stroke} />
    </svg>
  );
}

function TrophyTabIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7.5 4.5h9v4.8a4.5 4.5 0 0 1-9 0V4.5Z" {...stroke} />
      <path d="M7.5 6.5H5.2c0 2.6 1.1 4.2 2.9 4.7M16.5 6.5h2.3c0 2.6-1.1 4.2-2.9 4.7M12 13.8v3.4M8.5 20h7M9.8 17.2h4.4" {...stroke} />
    </svg>
  );
}

function YouIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" {...stroke} />
      <circle cx="12" cy="10" r="2.8" {...stroke} />
      <path d="M7 18c1-2.2 2.8-3.3 5-3.3s4 1.1 5 3.3" {...stroke} />
    </svg>
  );
}
