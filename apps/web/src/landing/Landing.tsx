/**
 * Landing page. Every figure on it is live: prices and traders come from the
 * API, and the hero phone draws the Everything basket's real history; only
 * the sub-second ticking is animation.
 */

import { api, type IndexList, type Market } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { navigate } from "../lib/router.ts";
import { CustodySection } from "./Custody.tsx";
import { FaqSection } from "./Faq.tsx";
import { HighlightsSection } from "./Highlights.tsx";
import { PhoneHero } from "./PhoneHero.tsx";
import { TradersSection } from "./Traders.tsx";
import "./landing.css";

const NAV = [
  ["Companies", "/companies"],
  ["Baskets", "/baskets"],
  ["Traders", "/traders"],
] as const;

export function Landing() {
  // One poll for the whole page. The market endpoint is the expensive read,
  // and every figure below is a different view of the same snapshot.
  const market = useAsync<Market>((signal) => api.market(signal), [], { pollMs: 30_000 });
  const indexes = useAsync<IndexList>((signal) => api.indexes(signal), []);

  const snapshot = market.data;

  return (
    <div className="landing">
      <header className="hero">
        <Nav />
        <PhoneHero market={snapshot} indexes={indexes.data} />
      </header>
      <BuiltOn />

      <main className="wrap">
        <HighlightsSection market={snapshot} />
        <TradersSection />
        <CustodySection market={snapshot} />

        <FaqSection market={snapshot} />

        <section className="closer">
          <h2>
            Own the future.
            <br />
            Keep the keys.
          </h2>
          <button className="btn-dark" onClick={() => navigate("/companies")}>
            Get started
          </button>
        </section>
      </main>

      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <nav className="nav" aria-label="Primary">
      <a className="nav-mark" href="/" onClick={link("/")} aria-label="Bigsec home">
        <Mark />
      </a>
      <div className="nav-links">
        {NAV.map(([label, href]) => (
          <a className="nav-link" key={href} href={href} onClick={link(href)}>
            {label}
          </a>
        ))}
      </div>
      <a className="nav-cta" href="/dashboard" onClick={link("/dashboard")}>
        Open app
      </a>
    </nav>
  );
}

function BuiltOn() {
  return (
    <div className="press">
      <div className="press-row">
        <span className="press-label">Built on:</span>
        <span className="press-item">Solana</span>
        <span className="press-item">Token-2022</span>
        <span className="press-item">PreStocks</span>
        <span className="press-item">Jupiter</span>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-grid">
        <div className="foot-social">
          <Mark size={22} />
        </div>
        <div className="foot-cols">
          <div className="foot-col">
            <h4>Buy</h4>
            <a href="/companies" onClick={link("/companies")}>Companies</a>
            <a href="/baskets" onClick={link("/baskets")}>Baskets</a>
            <a href="/dashboard" onClick={link("/dashboard")}>Dashboard</a>
            <a href="/traders" onClick={link("/traders")}>Traders</a>
          </div>
          <div className="foot-col">
            <h4>Yours</h4>
            <a href="/portfolio" onClick={link("/portfolio")}>What I own</a>
            <a href="/build" onClick={link("/build")}>Build your own</a>
          </div>
          <div className="foot-col">
            <h4>Understand</h4>
            <a href="/learn" onClick={link("/learn")}>How it works</a>
            <a href="/learn" onClick={link("/learn")}>Costs and risks</a>
          </div>
        </div>
      </div>
    </footer>
  );
}

/** The Bigsec mark: three stacked bars. */
function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="1" y="3" width="16" height="3" rx="1.5" fill="currentColor" />
      <rect x="1" y="7.5" width="11" height="3" rx="1.5" fill="currentColor" opacity="0.72" />
      <rect x="1" y="12" width="6.5" height="3" rx="1.5" fill="currentColor" opacity="0.44" />
    </svg>
  );
}

/** Intercept in-app links so navigation stays client side. */
function link(to: string) {
  return (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  };
}
