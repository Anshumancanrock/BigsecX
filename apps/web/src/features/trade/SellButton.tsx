/**
 * Selling in fractions of what is held (all, half, a quarter) with the dollar
 * value shown for each, rather than asking for a dollar amount.
 */

import { useEffect, useState } from "react";
import { Sheet } from "../../components/Sheet.tsx";
import { TradeDialog } from "./TradeDialog.tsx";
import { useWallet } from "../wallet/WalletContext.tsx";
import type { BuildRequest } from "../../lib/trade.ts";
import { ApiError, api } from "../../lib/api.ts";
import { usd } from "../../lib/format.ts";
import { feePercent } from "../../lib/words.ts";
import { useMarket } from "../../lib/market.ts";

const PORTIONS = [
  { label: "All of it", fraction: 1 },
  { label: "Half", fraction: 0.5 },
  { label: "A quarter", fraction: 0.25 },
] as const;

export function SellButton({
  symbol,
  name,
  className = "btn-ghost",
  label,
  onSettled,
}: {
  symbol?: string;
  name: string;
  className?: string;
  label?: string;
  onSettled?: () => void;
}) {
  const wallet = useWallet();
  const market = useMarket();
  const feeBps = (symbol ? market?.tokens.find((t) => t.symbol === symbol) : market?.tokens[0])?.transferFeeBps ?? 100;
  const [asking, setAsking] = useState(false);
  const [request, setRequest] = useState<BuildRequest | null>(null);
  const [fraction, setFraction] = useState(1);

  /*
   * Ask the server what the sale would return. Its minimum applies per
   * position, not to the total, so only the server can say which slices
   * would be refused.
   */
  const [preview, setPreview] = useState<
    { kind: "loading" } | { kind: "ok"; proceeds: number; count: number } | { kind: "no"; reason: string }
  >({ kind: "loading" });

  useEffect(() => {
    if (!asking || !wallet.address) return;
    const controller = new AbortController();
    setPreview({ kind: "loading" });

    api
      .exitPlan(
        { owner: wallet.address, ...(symbol ? { symbols: [symbol] } : {}), fraction },
        controller.signal,
      )
      .then((plan) => setPreview({ kind: "ok", proceeds: plan.proceedsUsd, count: plan.sells.length }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const body = (error as ApiError)?.body;
        const skipped = Array.isArray(body?.["skipped"]) ? (body["skipped"] as { reason?: string }[]) : [];
        const blocked = Array.isArray(body?.["blocked"]) ? (body["blocked"] as { reason?: string }[]) : [];
        const specific = blocked[0]?.reason ?? skipped[0]?.reason;
        setPreview({
          kind: "no",
          reason: specific ? `Cannot sell this: ${specific}.` : (error as Error).message,
        });
      });

    return () => controller.abort();
  }, [asking, wallet.address, symbol, fraction]);

  const ready = preview.kind === "ok";

  const open = () => {
    setFraction(1);
    setAsking(true);
  };

  return (
    <>
      <button className={className} onClick={open}>
        {label ?? "Sell"}
      </button>

      {asking ? (
        <Sheet
          title={`Sell ${name}`}
          onClose={() => setAsking(false)}
          footer={
            <>
              <button className="btn-ghost" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                className="btn-mint"
                disabled={!wallet.address || !ready}
                title={ready ? undefined : "Choose an amount that can be sold"}
                style={!wallet.address || !ready ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
                onClick={() => {
                  if (!wallet.address || !ready) return;
                  setRequest({
                    kind: "exit",
                    owner: wallet.address,
                    ...(symbol ? { symbols: [symbol] } : {}),
                    fraction,
                  });
                  setAsking(false);
                }}
              >
                See the exact price
              </button>
            </>
          }
        >
          <p className="note" style={{ marginBottom: 16 }}>
            {symbol ? `How much of your ${name} do you want to sell?` : "How much of everything you hold here do you want to sell?"}{" "}
            The money comes back to your wallet as USDC.
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {PORTIONS.map((portion) => (
              <button
                key={portion.fraction}
                className={fraction === portion.fraction ? "btn-mint" : "btn-ghost"}
                onClick={() => setFraction(portion.fraction)}
              >
                {portion.label}
              </button>
            ))}
          </div>

          <div className="kv">
            <span>Worth about</span>
            <span className="num">
              {preview.kind === "loading" ? "…" : preview.kind === "ok" ? usd(preview.proceeds) : "—"}
            </span>
          </div>
          {preview.kind === "no" ? (
            <p className="note" style={{ marginTop: 12, color: "hsl(var(--down))" }}>
              {preview.reason}{" "}
              {fraction < 1 ? "Try selling a larger share." : ""}
            </p>
          ) : (
            <p className="note" style={{ marginTop: 12 }}>
              {preview.kind === "ok" && preview.count > 1 ? `Across ${preview.count} companies. ` : ""}
              That is at today's price, before the {feePercent(feeBps)} fee and the price gap. You will see the exact
              amount before you approve anything.
            </p>
          )}

          {!wallet.address ? (
            <p className="note" style={{ marginTop: 10 }}>
              Connect the wallet holding these tokens to continue.
            </p>
          ) : null}
        </Sheet>
      ) : null}

      {request ? (
        <TradeDialog
          request={request}
          title={`Sell ${name}`}
          onClose={() => setRequest(null)}
          {...(onSettled ? { onSettled } : {})}
        />
      ) : null}
    </>
  );
}
