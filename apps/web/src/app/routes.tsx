import { useEffect } from "react";
import { api, type Market } from "../lib/api.ts";
import { ADDRESS_PATTERN } from "../lib/format.ts";
import { go, match } from "../lib/router.ts";
import { useAsync } from "../lib/useAsync.ts";
import { BasketDetail } from "../pages/BasketDetail.tsx";
import { Baskets } from "../pages/Baskets.tsx";
import { BuildBasket } from "../pages/BuildBasket.tsx";
import { Companies } from "../pages/Companies.tsx";
import { CompanyDetail } from "../pages/CompanyDetail.tsx";
import { Explore } from "../pages/Explore.tsx";
import { Home } from "../pages/Home.tsx";
import { Leaderboard } from "../pages/Leaderboard.tsx";
import { Learn } from "../pages/Learn.tsx";
import { MyProfile, ProfilePage } from "../pages/Profile.tsx";
import { Search } from "../pages/Search.tsx";

const SECTIONS = [
  { href: "/dashboard", label: "Home" },
  { href: "/companies", label: "Companies" },
  { href: "/baskets", label: "Baskets" },
  { href: "/build", label: "Build a basket" },
  { href: "/portfolio", label: "Profile" },
  { href: "/traders", label: "Leaderboard" },
  { href: "/search", label: "Search" },
  { href: "/learn", label: "How it works" },
] as const;

export function titleFor(path: string): string | null {
  return SECTIONS.find((s) => path === s.href || path.startsWith(`${s.href}/`))?.label ?? null;
}

export function Routed({
  path,
  market,
  loading,
  phone,
}: {
  path: string;
  market: Market | null;
  loading: boolean;
  phone: boolean;
}) {
  const basket = match("/baskets/:id", path) ?? match("/indexes/:id", path);
  if (basket) return <BasketDetail id={basket.id!} market={market} />;

  const company = match("/companies/:symbol", path);
  if (company) return <CompanyDetail symbol={company.symbol!} market={market} loading={loading} />;

  const trader = match("/traders/:wallet", path);
  if (trader) {
    if (!ADDRESS_PATTERN.test(trader.wallet!)) {
      return <NotFound message="That is not a Solana wallet address." href="/traders" label="See all traders" />;
    }
    // Keyed so that moving between profiles resets the page state.
    return <ProfilePage key={trader.wallet} wallet={trader.wallet!} market={market} />;
  }

  const user = match("/u/:handle", path);
  if (user) return <HandleRedirect handle={user.handle!} />;

  switch (path) {
    case "/dashboard":
    case "/explore":
      return phone ? <Home market={market} /> : <Explore market={market} />;
    case "/search":
      return <Search market={market} />;
    case "/companies":
    case "/assets":
      return <Companies market={market} loading={loading} />;
    case "/baskets":
    case "/indexes":
      return <Baskets />;
    case "/traders":
    case "/leaderboard":
      return <Leaderboard />;
    case "/portfolio":
      return <MyProfile market={market} />;
    case "/build":
    case "/compose":
      return <BuildBasket market={market} />;
    case "/learn":
    case "/risk":
    case "/how-it-works":
      return <Learn market={market} />;
    default:
      return <NotFound message="Nothing here." href="/dashboard" label="Back to the dashboard" />;
  }
}

function HandleRedirect({ handle }: { handle: string }) {
  const found = useAsync((signal) => api.handle(handle, signal), [handle]);
  useEffect(() => {
    if (!found.data) return;
    window.history.replaceState({}, "", `/traders/${found.data.wallet}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [found.data]);
  if (found.error) {
    return <NotFound message={`Nobody here has the username @${handle}.`} href="/traders" label="See the traders" />;
  }
  return <div className="shimmer" style={{ height: 240, marginTop: 24 }} />;
}

function NotFound({ message, href, label }: { message: string; href: string; label: string }) {
  return (
    <div className="empty" style={{ marginTop: 24 }}>
      {message}{" "}
      <a href={href} onClick={go(href)} style={{ textDecoration: "underline" }}>
        {label}
      </a>
      .
    </div>
  );
}
