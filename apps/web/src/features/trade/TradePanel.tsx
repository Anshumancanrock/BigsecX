/**
 * Buy or sell one company from its page. Checks the wallet, amount, USDC and
 * SOL for fees as the amount is typed and names what is missing on the
 * button; the order goes through the same review dialog as every trade.
 */

import { useState } from "react";
import { api, type Cash, type MarketToken, type PortfolioPosition } from "../../lib/api.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { shares, usd } from "../../lib/format.ts";
import type { BuildRequest } from "../../lib/trade.ts";
import { feeChangeWords, feePercent } from "../../lib/words.ts";
import { useMarket } from "../../lib/market.ts";
import { useWallet } from "../wallet/WalletContext.tsx";
import { ConnectSheetButton } from "../wallet/ConnectSheet.tsx";
import { FundingHelp } from "../wallet/FundingHelp.tsx";
import { TradeDialog } from "./TradeDialog.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { MAX_BUY_USD, MIN_BUY_USD, MIN_LAMPORTS, MIN_SELL_USD } from "../../lib/limits.ts";

export function TradePanel({
  token,
  position,
  onSettled,
}: {
  token: MarketToken;
  position: PortfolioPosition | null;
  onSettled: () => void;
}) {
  const wallet = useWallet();
  const market = useMarket();
  // A scheduled fee change is said where the fee is, before anyone buys.
  const feeChange = feeChangeWords(market?.pendingFeeChange, market?.epoch);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [unit, setUnit] = useState<"usd" | "token">("usd");
  const [raw, setRaw] = useState("");
  const [request, setRequest] = useState<BuildRequest | null>(null);
  const cash = useAsync<Cash | null>(
    (signal) => (wallet.address ? api.cash(wallet.address, signal) : Promise.resolve(null)),
    [wallet.address],
    { pollMs: 60_000 },
  );

  // Sells convert at the price the holding is valued at, so MAX equals the
  // holding exactly; the live market price would not round-trip.
  const unitPrice = side === "sell" && position?.priceUsd ? position.priceUsd : token.marketUsd;
  const typed = Number(raw.replace(/,/g, ""));
  const entered = Number.isFinite(typed) && typed > 0 ? typed : 0;
  const amountUsd = unit === "usd" ? entered : unitPrice ? entered * unitPrice : 0;
  const amountTokens = unitPrice ? amountUsd / unitPrice : 0;

  const heldUsd = position?.valueUsd ?? 0;
  const usdc = cash.data?.usdcUsd ?? null;
  const noSol = cash.data !== null && cash.data !== undefined && cash.data.solLamports < MIN_LAMPORTS;

  const switchSide = (next: "buy" | "sell") => {
    setSide(next);
    setRaw("");
  };
  const setMax = () => {
    const maxUsd = side === "buy" ? Math.min(usdc ?? 0, MAX_BUY_USD) : heldUsd;
    const value = unit === "usd" ? Math.floor(maxUsd * 100) / 100 : unitPrice ? maxUsd / unitPrice : 0;
    setRaw(value > 0 ? String(unit === "usd" ? value : Number(value.toFixed(6))) : "");
  };

  // What stands between this amount and the review screen, in order.
  const blocker = ((): string | null => {
    if (side === "buy") {
      if (token.paused) return "Paused by the issuer";
      if (unitPrice === null) return "No price right now";
      if (amountUsd === 0) return "Enter an amount";
      if (amountUsd < MIN_BUY_USD) return `The smallest buy is ${usd(MIN_BUY_USD).replace(".00", "")}`;
      if (amountUsd > MAX_BUY_USD) return "That is more than one buy can take";
      if (usdc !== null && amountUsd > usdc + 1e-6) return "Not enough USDC";
      if (noSol) return "Add a little SOL for fees";
      return null;
    }
    if (!position || position.uiAmount <= 0) return `You hold no ${token.name}`;
    if (position.frozen) return "Frozen by the issuer";
    if (token.paused) return "Paused by the issuer";
    if (amountUsd === 0) return "Enter an amount";
    if (amountUsd < MIN_SELL_USD) return "Too small to sell";
    if (amountUsd > heldUsd * 1.0001) return "More than you hold";
    return null;
  })();

  const start = () => {
    if (!wallet.address || blocker) return;
    if (side === "buy") {
      setRequest({ kind: "mirror", owner: wallet.address, weights: [{ symbol: token.symbol, weight: 1 }], deployUsd: amountUsd });
    } else {
      // Within a hair of everything is everything: a fraction a rounding
      // error short of 1 would leave dust behind.
      const fraction = heldUsd > 0 ? Math.min(1, amountUsd / heldUsd) : 1;
      setRequest({ kind: "exit", owner: wallet.address, symbols: [token.symbol], fraction: fraction > 0.995 ? 1 : fraction });
    }
  };

  const verb = side === "buy" ? "Buy" : "Sell";

  return (
    <section className="card trade-panel">
      <Segmented
        className="trade-tabs"
        label="Buy or sell"
        options={[
          { value: "buy", label: "Buy" },
          { value: "sell", label: "Sell" },
        ]}
        value={side}
        onChange={switchSide}
      />

      <label className="trade-amount">
        <span className="trade-input">
          {unit === "usd" ? <span className="trade-currency">$</span> : null}
          <input
            inputMode="decimal"
            placeholder="0"
            value={raw}
            aria-label={unit === "usd" ? "Amount in US dollars" : `Amount in ${token.symbol}`}
            onChange={(event) => setRaw(event.target.value.replace(/[^0-9.,]/g, ""))}
          />
        </span>
        <span className="trade-unit">{unit === "usd" ? "USD" : token.symbol}</span>
      </label>
      <div className="trade-sub">
        <button
          className="trade-convert"
          onClick={() => {
            setUnit(unit === "usd" ? "token" : "usd");
            setRaw("");
          }}
          aria-label="Switch between dollars and tokens"
        >
          {unit === "usd" ? `≈ ${shares(amountTokens)} ${token.symbol}` : `≈ ${usd(amountUsd)}`}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3.5 1.5v9M1.5 3.5l2-2 2 2M8.5 10.5v-9M6.5 8.5l2 2 2-2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {wallet.address ? (
          <button className="trade-max" onClick={setMax}>
            MAX
          </button>
        ) : null}
      </div>

      {!wallet.address ? (
        <ConnectSheetButton className="btn-mint trade-go" label={`Connect a wallet to ${verb.toLowerCase()}`} />
      ) : (
        <button className="btn-mint trade-go" disabled={Boolean(blocker)} onClick={start}>
          {blocker ?? (side === "buy" ? `Buy ${usd(amountUsd)} of ${token.name}` : `Sell ${usd(amountUsd)} of ${token.name}`)}
        </button>
      )}

      <p className="trade-foot">
        {side === "buy"
          ? usdc === null
            ? "Paid in USDC. It lands in your own wallet."
            : `Available USDC on Solana: ${usd(usdc)}`
          : position && position.uiAmount > 0
            ? `You hold ${shares(position.uiAmount)} ${token.symbol}, worth ${usd(heldUsd)}`
            : `Nothing to sell yet.`}
      </p>
      <p className="trade-fine">
        {feePercent(token.transferFeeBps)} fee on every buy and sell. You review the exact price before you sign.
        {feeChange ? <b className="trade-fee-change"> {feeChange}</b> : null}
      </p>

      {wallet.address && side === "buy" && usdc !== null && (usdc < MIN_BUY_USD || noSol) ? (
        <FundingHelp address={wallet.address} needUsdc={usdc < MIN_BUY_USD} needSol={noSol} />
      ) : null}

      {request ? (
        <TradeDialog
          request={request}
          title={`${verb} ${token.name}`}
          onClose={() => setRequest(null)}
          onSettled={() => {
            setRaw("");
            cash.refresh();
            onSettled();
          }}
        />
      ) : null}
    </section>
  );
}
