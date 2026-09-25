/**
 * Landing page. Every figure on it is live: feature figures and index weights
 * come from the market snapshot, and the hero phone draws the Everything
 * basket's real history; only the sub-second ticking is animation.
 */

import { api, type IndexList, type Market } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { navigate } from "../lib/router.ts";
import { list } from "../lib/format.ts";
import {
  BasisFigure,
  ControlFigure,
  CustodyFigure,
  DepthFigure,
  FeeFigure,
  MoversFigure,
  WeightsFigure,
} from "./Figures.tsx";
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
  const flagship = list(indexes.data?.indexes).find((i) => i.id === "pre8") ?? list(indexes.data?.indexes)[0] ?? null;

  return (
    <div className="landing">
      <header className="hero">
        <Nav />
        <PhoneHero market={snapshot} indexes={indexes.data} />
      </header>
      <BuiltOn />

      <main className="wrap">
        <TradersSection />
        <HighlightsSection market={snapshot} />
        <CustodySection market={snapshot} />

        <section className="prose">
          <p>
            <b>For most of its life, the only way to own a piece of SpaceX was to be an insider or a
            fund.</b> OpenAI and Anthropic may never list at all. The companies defining the next
            decade are owned by funds and insiders, and everyone else waits for an IPO that keeps
            not arriving.
          </p>
          <p>
            These are tokens that track those companies, and you can buy them today with about
            thirty dollars. One company on its own, or a ready-made basket of them, in a single
            approval. <b>They land in your own wallet, and we never hold your money or your keys.</b>
          </p>
        </section>

        <section className="section">
          <h2>Priced before you sign.</h2>
          <div className="cards">
            <Card caption="You see the exact price, and the exact fee, before you approve anything. No surprises after.">
              <DepthFigure market={snapshot} />
            </Card>
            <Card caption="Every cost is included in the number you are shown — the fee, the spread, all of it.">
              <FeeFigure market={snapshot} />
            </Card>
            <Card caption="The tokens land in your own wallet. We never hold your money, and we never hold a key.">
              <CustodyFigure />
            </Card>
          </div>
          <div className="card-wide">
            <WeightsFigure weights={flagship?.weights ?? null} />
            <p>
              Buy one company on its own, or a ready-made basket — the AI labs, space and defence,
              prediction markets. Or build your own mix and share it.
            </p>
          </div>
        </section>

        <section className="section center">
          <div className="ring-wrap">
            <div className="rings" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <h2>The market, as it actually trades.</h2>
          </div>
          <div className="cards">
            <Card caption="What the issuer says a company is worth, next to what the market will actually pay for it.">
              <BasisFigure market={snapshot} />
            </Card>
            <Card caption="Prices are checked live, every time — never guessed from a stale table.">
              <MoversFigure market={snapshot} />
            </Card>
            <Card caption="What the issuer can do to your tokens is spelled out on every company page.">
              <ControlFigure market={snapshot} />
            </Card>
          </div>
          <div className="card-wide">
            <p>
              The things an issuer would rather you scrolled past. We put them on the company page,
              in plain words, before you buy.
            </p>
          </div>
        </section>

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
      <a className="nav-mark" href="/" onClick={link("/")} aria-label="BasketX home">
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

function Card({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    <div>
      <div className="card-figure">{children}</div>
      <p className="card-caption">{caption}</p>
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

/** The BasketX mark: a basket as three stacked bars. */
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
