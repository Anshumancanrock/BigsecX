/**
 * A company page: price chart, what the token represents, the issuer's
 * on-chain powers over it, and the trade panel.
 */

import { Ticking } from "../components/Ticker.tsx";
import { api, type IndexList, type Market, type Portfolio, type PositionResponse } from "../lib/api.ts";
import { useAsync } from "../lib/useAsync.ts";
import { list, pct, price, shares, usd, usdCompact, weight } from "../lib/format.ts";
import { feeChangeWords, feeWords, issuerPowers, priceGapWords, THE_HONEST_CAVEAT } from "../lib/words.ts";
import { useWallet } from "../features/wallet/WalletContext.tsx";
import { go } from "../lib/router.ts";
import { TokenLogo } from "../components/TokenLogo.tsx";
import { AssetChart } from "../components/charts/AssetChart.tsx";
import { TradePanel } from "../features/trade/TradePanel.tsx";

export function CompanyDetail({
  symbol: raw,
  market,
  loading,
}: {
  symbol: string;
  market: Market | null;
  loading: boolean;
}) {
  const symbol = raw.toUpperCase();
  const wallet = useWallet();
  const token = list(market?.tokens).find((t) => t.symbol === symbol) ?? null;

  const indexes = useAsync<IndexList>((signal) => api.indexes(signal), []);
  const portfolio = useAsync<Portfolio | null>(
    (signal) => (wallet.address ? api.portfolio(wallet.address, signal) : Promise.resolve(null)),
    [wallet.address],
  );
  const held = useAsync<PositionResponse | null>(
    (signal) => (wallet.address && token ? api.position(wallet.address, token.symbol, signal) : Promise.resolve(null)),
    [wallet.address, token?.symbol],
  );

  if (!token) {
    if (!market && loading) return <div className="shimmer" style={{ height: 320, marginTop: 18 }} />;
    return (
      <div className="empty">
        There is no company called “{raw}” here.{" "}
        <a href="/companies" onClick={go("/companies")} style={{ textDecoration: "underline" }}>
          See all companies
        </a>
        .
      </div>
    );
  }

  const move = token.change24hPct;
  const gap = priceGapWords(token.basis);
  const powers = issuerPowers(token.issuerControl, token.paused);
  const inBaskets = list(indexes.data?.indexes)
    .map((index) => ({ index, share: list(index.weights).find((w) => w.symbol === token.symbol)?.weight ?? 0 }))
    .filter((entry) => entry.share > 0);
  const position = held.data?.position ?? null;
  const owns = position !== null && position.uiAmount > 0;

  return (
    <>
      <a className="page-back" href="/companies" onClick={go("/companies")}>
        ← All companies
      </a>

      <header className="asset-head">
        <TokenLogo symbol={token.symbol} size={72} />
        <div className="asset-title">
          <h1>
            {token.name}
            {token.verified ? <VerifiedMark /> : null}
          </h1>
          <p>{token.symbol} on Solana</p>
        </div>
        <div className="asset-price">
          <b className="num">
            <Ticking value={token.marketUsd} />
          </b>
          <small className={`num ${move == null ? "muted" : move >= 0 ? "up" : "down"}`}>
            {move == null ? "—" : `${move >= 0 ? "▲" : "▼"} ${Math.abs(move).toFixed(2)}% today`}
          </small>
        </div>
      </header>

      <div className="asset-grid">
        <AssetChart symbol={token.symbol} />
        <TradePanel token={token} position={position} onSettled={held.refresh} />
      </div>

      <section className="asset-holdings">
        <h2 className="section-title">Your holdings</h2>
        <div className="holding-tiles">
          <div className="card holding-tile">
            <span>Value</span>
            <b className="num">{wallet.address ? usd(position?.valueUsd ?? 0) : "—"}</b>
          </div>
          <div className="card holding-tile">
            <span>Amount held</span>
            <b className="num">
              {wallet.address ? `${shares(position?.uiAmount ?? 0)} ${token.symbol}` : "—"}
            </b>
          </div>
          <div className="card holding-tile">
            <span>Share of what you own</span>
            <b className="num">
              {wallet.address
                ? portfolio.data && portfolio.data.totalUsd > 0
                  ? weight((position?.valueUsd ?? 0) / portfolio.data.totalUsd)
                  : "0%"
                : "—"}
            </b>
          </div>
        </div>
        {!wallet.address ? <p className="note">Connect a wallet to see what you hold.</p> : null}
        {owns && position.frozen ? (
          <p className="note" style={{ color: "hsl(var(--down))" }}>
            The issuer has frozen your {token.name} tokens, so they cannot be sold right now.
          </p>
        ) : null}
      </section>

      <div className="company-grid">
        <section className="card">
          <h3 className="sub-head">What you are buying</h3>
          <p className="note">{THE_HONEST_CAVEAT}</p>
          <p className="note" style={{ marginTop: 8 }}>
            <a href="/learn" onClick={go("/learn")} style={{ textDecoration: "underline" }}>
              How it works, and the risks
            </a>
          </p>

          {powers.length > 0 ? (
            <>
              <h3 className="sub-head">What the issuer can do</h3>
              {powers.map((p) => (
                <p className="note" key={p.title} style={{ marginBottom: 8 }}>
                  <b style={{ color: "hsl(var(--down))", fontWeight: 500 }}>{p.title}.</b> {p.detail}
                </p>
              ))}
            </>
          ) : null}
        </section>

        <section className="card">
          <h3 className="sub-head">The numbers</h3>
          <div className="kv">
            <span>Market price</span>
            <span className="num">{price(token.marketUsd)}</span>
          </div>
          <div className="kv">
            <span>The issuer's official price</span>
            <span className="num">{price(token.markUsd)}</span>
          </div>
          <div className="kv">
            <span>Difference</span>
            <span className={gap.tone}>{gap.label}</span>
          </div>
          <div className="kv">
            <span>Available to trade right now</span>
            <span className="num">{usdCompact(token.liquidityUsd)}</span>
          </div>
          <div className="kv">
            <span>Cost to trade</span>
            <span>{feeWords(token.transferFeeBps)}</span>
          </div>
          {feeChangeWords(market?.pendingFeeChange, market?.epoch) ? (
            <p className="note down" style={{ marginTop: 6 }}>
              {feeChangeWords(market?.pendingFeeChange, market?.epoch)}
            </p>
          ) : null}
          <div className="kv">
            <span>Today</span>
            <span className={`num ${move == null ? "muted" : move >= 0 ? "up" : "down"}`}>{pct(move)}</span>
          </div>

          {inBaskets.length > 0 ? (
            <>
              <h3 className="sub-head">In these baskets</h3>
              {inBaskets.map(({ index, share }) => (
                <div className="kv" key={index.id}>
                  <a href={`/baskets/${index.id}`} onClick={go(`/baskets/${index.id}`)} style={{ textDecoration: "underline" }}>
                    {index.name}
                  </a>
                  <span className="num">{weight(share)} of it</span>
                </div>
              ))}
            </>
          ) : null}
        </section>
      </div>
    </>
  );
}

/** The directory's verified tick, beside the company's name. */
export function VerifiedMark() {
  return (
    <svg className="verified" width="22" height="22" viewBox="0 0 24 24" role="img" aria-label="Verified token">
      <path
        d="M12 1.8l2.4 1.8 3-.2.9 2.9 2.5 1.7-.9 2.9.9 2.9-2.5 1.7-.9 2.9-3-.2L12 22.2l-2.4-1.8-3 .2-.9-2.9-2.5-1.7.9-2.9-.9-2.9 2.5-1.7.9-2.9 3 .2z"
        fill="hsl(149 88% 60%)"
      />
      <path d="M8 12.3l2.6 2.6L16.2 9.3" fill="none" stroke="hsl(160 30% 6%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
