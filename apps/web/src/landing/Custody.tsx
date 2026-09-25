import { TokenLogo } from "../components/TokenLogo.tsx";
import type { Market } from "../lib/api.ts";
import { list, price } from "../lib/format.ts";
import { MarketContext } from "../lib/market.ts";

const EXAMPLE_USD = 250;
const EXAMPLE_SYMBOL = "ANTHROPIC";

export function CustodySection({ market }: { market: Market | null }) {
  return (
    <MarketContext.Provider value={market}>
      <section className="section custody">
        <div className="cu-copy">
          <p className="cu-eyebrow">Self-custody</p>
          <h2>
            We never hold your money.
            <span>Every share lands in your wallet.</span>
          </h2>
          <p className="cu-lead">
            Each trade is a Solana transaction that your own wallet signs, and the tokens go straight to your account.
            Bigsec builds and prices the transaction. It never sees your keys or holds your funds, so there is nothing
            with us to lose.
          </p>
          <ul className="cu-points">
            <li>
              <KeyIcon />
              Signed in your own wallet, one approval per trade
            </li>
            <li>
              <ShieldIcon />
              Settled on Solana, checkable on any explorer
            </li>
            <li>
              <EyeIcon />
              The issuer&rsquo;s powers over each token, shown before you buy
            </li>
          </ul>
        </div>
        <Ticket market={market} />
      </section>
    </MarketContext.Provider>
  );
}

function Ticket({ market }: { market: Market | null }) {
  const token = list(market?.tokens).find((t) => t.symbol === EXAMPLE_SYMBOL) ?? null;
  const feeBps = token?.transferFeeBps ?? null;
  const shares =
    token?.marketUsd && feeBps !== null ? (EXAMPLE_USD * (1 - feeBps / 10_000)) / token.marketUsd : null;

  return (
    <div className="cu-stage" aria-label="Example trade">
      <div className="cu-ticket">
        <div className="cu-ticket-head">
          <TokenLogo symbol={EXAMPLE_SYMBOL} size={38} badge={false} />
          <span className="cu-ticket-name">
            <b>{token?.name ?? "Anthropic"}</b>
            <small className="num">{price(token?.marketUsd ?? null)}</small>
          </span>
          <span className="cu-side" aria-hidden="true">
            <span className="on">Buy</span>
            <span>Sell</span>
          </span>
        </div>

        <div className="cu-box">
          <small>You pay</small>
          <strong className="num">
            {EXAMPLE_USD.toFixed(2)} <em>USDC</em>
          </strong>
        </div>
        <div className="cu-box">
          <small>You receive</small>
          <strong className="num">
            {shares === null ? "—" : `≈ ${shares.toFixed(4)}`} <em>shares</em>
          </strong>
        </div>

        <dl className="cu-rows">
          <div>
            <dt>Transfer fee</dt>
            <dd className="num">{feeBps === null ? "—" : `${(feeBps / 100).toFixed(2)}%`}</dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>Jupiter, on Solana</dd>
          </div>
          <div>
            <dt>Settles to</dt>
            <dd>Your wallet</dd>
          </div>
        </dl>

        <span className="cu-approve" aria-hidden="true">
          <WalletIcon />
          Approve in your wallet
        </span>
        <div className="cu-chip" aria-hidden="true">
          <i>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </i>
          <span>
            <b>Confirmed on Solana</b>
            <small>Tokens in your wallet</small>
          </span>
        </div>
      </div>
    </div>
  );
}

const stroke = { stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="15" r="4" {...stroke} />
      <path d="M10.9 12.1 20 3M16.4 6.6 19 9.2M13.9 9.1l2 2" {...stroke} />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3 5 6v5.2c0 4.3 2.9 8.2 7 9.3 4.1-1.1 7-5 7-9.3V6l-7-3Z" {...stroke} />
      <path d="m9 12 2.2 2.2L15.5 10" {...stroke} />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" {...stroke} />
      <circle cx="12" cy="12" r="3" {...stroke} />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" {...stroke} />
      <path d="M4 7.5v10A2.5 2.5 0 0 0 6.5 20H20V8H6.5A2.5 2.5 0 0 1 4 5.5" {...stroke} />
      <circle cx="16" cy="14" r="1.2" fill="currentColor" />
    </svg>
  );
}
