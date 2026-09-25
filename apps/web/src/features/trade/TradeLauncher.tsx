/**
 * Buy flow: amount, then review, then sign. A build quotes every leg against
 * live depth and is expensive, so it runs only once an amount is confirmed.
 * The amount step checks the wallet, the spendable balance and, for a basket,
 * the smallest amount at which every company clears the per-company minimum.
 */

import { useEffect, useState } from "react";
import { Sheet } from "../../components/Sheet.tsx";
import { TradeDialog } from "./TradeDialog.tsx";
import { useWallet } from "../wallet/WalletContext.tsx";
import { WalletPicker } from "../wallet/ConnectButton.tsx";
import { FundingHelp } from "../wallet/FundingHelp.tsx";
import type { BuildRequest } from "../../lib/trade.ts";
import { api, type Cash, type Weight } from "../../lib/api.ts";
import { navigate } from "../../lib/router.ts";
import { usd } from "../../lib/format.ts";
import { MAX_BUY_USD, MIN_BASKET_USD, MIN_BUY_USD, MIN_LAMPORTS } from "../../lib/limits.ts";

const PRESETS = [50, 100, 250] as const;

const whole = (value: number) => usd(value).replace(".00", "");

export function TradeLauncher({
  label,
  title,
  prompt,
  makeRequest,
  className = "btn-mint",
  onSettled,
  weights,
}: {
  label: string;
  title: string;
  prompt: string;
  /** Built once the amount is known; `owner` comes from the connected wallet. */
  makeRequest: (owner: string, amountUsd: number) => BuildRequest;
  className?: string;
  onSettled?: () => void;
  /** A basket's weights, to say what it takes to buy every company in it. */
  weights?: readonly Weight[] | null | undefined;
}) {
  const wallet = useWallet();
  const [asking, setAsking] = useState(false);
  const [request, setRequest] = useState<BuildRequest | null>(null);
  const [raw, setRaw] = useState("100");
  const [touched, setTouched] = useState(false);
  const [cash, setCash] = useState<Cash | null>(null);
  const [cashFailed, setCashFailed] = useState(false);

  const smallest = weights && weights.length > 1 ? Math.min(...weights.map((w) => w.weight)) : null;
  // Rounded up to the next $5 so the suggestion is a number a person types.
  const everyCompanyUsd = smallest ? Math.ceil(MIN_BUY_USD / smallest / 5) * 5 : null;

  // What the wallet can spend, asked each time the sheet opens: a balance
  // from ten minutes ago is how somebody is told they cannot afford
  // something they just funded.
  useEffect(() => {
    if (!asking || !wallet.address) return;
    const controller = new AbortController();
    setCash(null);
    setCashFailed(false);
    api
      .cash(wallet.address, controller.signal)
      .then((next) => setCash(next))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Unknown is not zero. The build still checks, so say nothing more.
        setCashFailed(true);
      });
    return () => controller.abort();
  }, [asking, wallet.address]);

  // Until the user types, an unaffordable default is replaced by the balance
  // so the sheet does not open on an error.
  useEffect(() => {
    if (!cash || touched) return;
    const current = Number(raw);
    if (cash.usdcUsd >= MIN_BASKET_USD && current > cash.usdcUsd) setRaw(String(Math.floor(cash.usdcUsd)));
  }, [cash, touched, raw]);

  const open = () => {
    setTouched(false);
    setRaw(String(everyCompanyUsd && everyCompanyUsd > 100 && everyCompanyUsd <= 500 ? everyCompanyUsd : 100));
    setAsking(true);
  };

  const amount = Number(raw);
  const inRange = Number.isFinite(amount) && amount >= MIN_BASKET_USD && amount <= MAX_BUY_USD;
  const tooMuch = cash !== null && amount > cash.usdcUsd + 1e-6;
  const broke = cash !== null && cash.usdcUsd < MIN_BASKET_USD;
  const noSol = cash !== null && cash.solLamports < MIN_LAMPORTS;
  const valid = inRange && !tooMuch && !noSol;
  const ready = valid && Boolean(wallet.address);

  const affordable = (value: number) => cash === null || value <= cash.usdcUsd;
  const presets = [
    ...PRESETS.filter(affordable),
    ...(everyCompanyUsd && affordable(everyCompanyUsd) && !PRESETS.includes(everyCompanyUsd as (typeof PRESETS)[number])
      ? [everyCompanyUsd]
      : []),
  ].sort((a, b) => a - b);

  return (
    <>
      <button className={className} onClick={open}>
        {label}
      </button>

      {asking ? (
        <Sheet
          title={title}
          onClose={() => setAsking(false)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                className="btn-mint"
                disabled={!ready}
                style={!ready ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
                onClick={() => {
                  if (!wallet.address || !ready) return;
                  setRequest(makeRequest(wallet.address, amount));
                  setAsking(false);
                }}
              >
                See the exact price
              </button>
            </>
          }
        >
          <p className="note" style={{ marginBottom: 16 }}>
            {prompt}
          </p>

          {!wallet.address ? (
            <div className="inline-picker">
              <p className="note" style={{ marginBottom: 8 }}>
                First, connect a wallet. Nothing is signed until you have seen the exact price.
              </p>
              <WalletPicker />
            </div>
          ) : (
            <>
              <label>
                <span className="amount-head">
                  <span className="tile-note">How much, in US dollars?</span>
                  <span className="tile-note">
                    {cash ? `You have ${usd(cash.usdcUsd)} USDC` : cashFailed ? "" : "Checking your balance…"}
                  </span>
                </span>
                <span className="amount-field">
                  <span aria-hidden="true">$</span>
                  <input
                    className="field"
                    value={raw}
                    onChange={(event) => {
                      setTouched(true);
                      setRaw(event.target.value.replace(/[^0-9.]/g, ""));
                    }}
                    inputMode="decimal"
                    autoFocus
                    aria-label="How much, in US dollars?"
                  />
                </span>
              </label>

              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {presets.map((preset) => (
                  <button
                    key={preset}
                    className={Number(raw) === preset ? "btn-mint" : "btn-ghost"}
                    onClick={() => {
                      setTouched(true);
                      setRaw(String(preset));
                    }}
                  >
                    {whole(preset)}
                  </button>
                ))}
                {cash && cash.usdcUsd >= MIN_BASKET_USD ? (
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      setTouched(true);
                      setRaw(String(Math.floor(Math.min(cash.usdcUsd, MAX_BUY_USD))));
                    }}
                  >
                    All of it
                  </button>
                ) : null}
              </div>

              {raw && !inRange ? (
                <p className="note warn-note">
                  {amount < MIN_BASKET_USD
                    ? `The smallest amount is ${whole(MIN_BASKET_USD)} — below that, fees take too big a bite.`
                    : `The most in one go is ${whole(MAX_BUY_USD)}.`}
                </p>
              ) : tooMuch && !broke ? (
                <p className="note warn-note">That is more than the {usd(cash!.usdcUsd)} of USDC in your wallet.</p>
              ) : null}

              {everyCompanyUsd && inRange && amount < everyCompanyUsd ? (
                <p className="note" style={{ marginTop: 10 }}>
                  At this amount the smallest parts of this mix are skipped. Put in {whole(everyCompanyUsd)} or more
                  to get all {weights!.length} companies.
                </p>
              ) : null}

              {broke || noSol ? (
                <FundingHelp address={wallet.address} needUsdc={broke} needSol={noSol} />
              ) : null}
            </>
          )}

          {/* Said once, before anyone spends anything. */}
          <p className="note" style={{ marginTop: 16, color: "hsl(var(--fg-faint))" }}>
            This is not stock: it is a token whose price tracks the company, set by a small market. Prices move, and
            the issuer keeps some powers over it.{" "}
            <a
              href="/learn"
              onClick={(event) => {
                event.preventDefault();
                setAsking(false);
                navigate("/learn");
              }}
              style={{ textDecoration: "underline" }}
            >
              What am I buying?
            </a>
          </p>
        </Sheet>
      ) : null}

      {request ? (
        <TradeDialog
          request={request}
          title={title}
          onClose={() => setRequest(null)}
          {...(onSettled ? { onSettled } : {})}
        />
      ) : null}
    </>
  );
}
