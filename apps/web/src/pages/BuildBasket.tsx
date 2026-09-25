/**
 * Build and publish a basket. Publishing requires a wallet signature, so a
 * basket cannot be published under someone else's address. Weights are
 * integer parts normalised on read, so each slider moves independently and
 * the total is always exactly 100%.
 */

import { TokenLogo } from "../components/TokenLogo.tsx";
import { useMemo, useState } from "react";
import { api, type Market } from "../lib/api.ts";
import { signedRequest } from "../lib/authed.ts";
import { navigate } from "../lib/router.ts";
import { list, weight as fmtWeight } from "../lib/format.ts";
import { liquidityWords } from "../lib/words.ts";
import { useWallet } from "../features/wallet/WalletContext.tsx";
import { WalletPicker } from "../features/wallet/ConnectButton.tsx";
import { useCompanyName } from "../lib/market.ts";
import { TradeLauncher } from "../features/trade/TradeLauncher.tsx";
import { PageHead } from "../components/PageHead.tsx";

type Parts = Record<string, number>;

export function BuildBasket({ market }: { market: Market | null }) {
  const wallet = useWallet();
  const nameOf = useCompanyName();
  const [parts, setParts] = useState<Parts>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const picked = useMemo(
    () => Object.entries(parts).filter(([, value]) => value > 0),
    [parts],
  );
  const total = picked.reduce((sum, [, value]) => sum + value, 0);

  const weights = picked.map(([symbol, value]) => ({ symbol, weight: value / total }));
  // The server enforces the same floor; checking here means the author sees
  // it while editing rather than after signing.
  const enough = picked.length >= 2;
  const named = name.trim().length >= 3;
  const ready = enough && named && Boolean(wallet.address);

  const toggle = (symbol: string) =>
    setParts((current) => {
      const next = { ...current };
      if (next[symbol]) delete next[symbol];
      else next[symbol] = 1;
      return next;
    });

  async function submit() {
    if (!wallet.connection || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        creator: wallet.address,
        name: name.trim(),
        weights,
        rebalance: "manual",
        published: true,
        ...(description.trim() ? { description: description.trim() } : {}),
      };
      const saved = await signedRequest(
        wallet.connection,
        { action: "create-strategy", resource: "new" },
        payload,
        (body) => api.createStrategy(body),
      );
      setCreated({ id: saved.id });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const path = `/baskets/${created.id}`;
    const link = `${window.location.origin}${path}`;
    return (
      <>
        <PageHead title={`${name.trim()} is live`} back={{ href: "/baskets", label: "Baskets" }} />
        <div className="banner">
          <span>Anyone with this link can see it and buy it. Share it wherever you like.</span>
        </div>
        <div className="funding-address" style={{ marginTop: 12 }}>
          <code>{link}</code>
          <button
            className="btn-ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        <div className="kv" style={{ marginTop: 12 }}>
          <span>In it</span>
          <span>{weights.map((w) => `${nameOf(w.symbol)} ${fmtWeight(w.weight, 0)}`).join(" · ")}</span>
        </div>
        <div className="sheet-foot" style={{ justifyContent: "flex-start" }}>
          <TradeLauncher
            label="Buy it now"
            title={`Buy ${name.trim()}`}
            prompt="How much do you want to put in? It is split across the basket you just made, in the shares you set. Nothing you already own is sold."
            weights={weights}
            makeRequest={(owner, amountUsd) => ({
              kind: "mirror",
              owner,
              strategyId: created.id,
              deployUsd: amountUsd,
            })}
          />
          <button className="btn-ghost" onClick={() => navigate(path)}>
            Open its page
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              setCreated(null);
              setParts({});
              setName("");
              setDescription("");
            }}
          >
            Make another
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Build your own" back={{ href: "/baskets", label: "Baskets" }} />
      <div className="section-head" style={{ marginTop: 0 }}>
        <p className="lede" style={{ margin: 0 }}>
          Pick two or more companies, set how much of each, and give it a name. Anyone can then buy your mix from its
          link.
        </p>
        <span className="note">{picked.length} of {list(market?.tokens).length ?? 0} picked</span>
      </div>

      {!market ? (
        <div className="shimmer" style={{ height: 240 }} />
      ) : (
        <div className="grid" style={{ marginBottom: 24 }}>
          {list(market.tokens).map((token) => {
            const on = (parts[token.symbol] ?? 0) > 0;
            return (
              <button
                key={token.mint}
                className="tile"
                style={{
                  minHeight: 128,
                  borderColor: on ? "hsl(var(--mint))" : undefined,
                  background: on ? "hsl(var(--mint) / 0.08)" : undefined,
                }}
                aria-pressed={on}
                onClick={() => toggle(token.symbol)}
              >
                <span className="cell-name">
                  <TokenLogo symbol={token.symbol} size={34} />
                  <span>
                    <b>{token.name}</b>
                    <small>{liquidityWords(token.liquidityUsd).label}</small>
                  </span>
                </span>
                {on ? (
                  <span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={parts[token.symbol] ?? 1}
                      aria-label={`${token.symbol} weight`}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        event.stopPropagation();
                        const value = Number(event.target.value);
                        setParts((current) => ({ ...current, [token.symbol]: value }));
                      }}
                      style={{ width: "100%", accentColor: "hsl(var(--mint))" }}
                    />
                    <span className="tile-note" style={{ textTransform: "none" }}>
                      {fmtWeight((parts[token.symbol] ?? 0) / total)} of the basket · slide to change
                    </span>
                  </span>
                ) : (
                  <span className="tile-note">Tap to include</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          <span className="tile-note" style={{ display: "block", marginBottom: 6 }}>
            Name
          </span>
          <input
            className="field"
            value={name}
            maxLength={60}
            placeholder="Frontier compute"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label>
          <span className="tile-note" style={{ display: "block", marginBottom: 6 }}>
            Why these companies? (optional)
          </span>
          <textarea
            className="field"
            value={description}
            maxLength={280}
            rows={3}
            placeholder="What you think these have in common, and why now."
            onChange={(event) => setDescription(event.target.value)}
            style={{ resize: "vertical" }}
          />
        </label>

        {error ? (
          <div className="banner bad">
            <span>{error}</span>
          </div>
        ) : null}

        <p className="note">
          {!wallet.address
            ? "Connect a wallet to publish. Your wallet signs the basket, which is what proves you made it."
            : !enough
              ? "Pick at least two companies. For just one, buy it from its own page."
              : !named
                ? "Give it a name of at least three characters."
                : `Publishing as ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}. Your wallet signs a message — no transaction, no fee.`}
        </p>
        {!wallet.address ? (
          <div className="inline-picker" style={{ maxWidth: 320 }}>
            <WalletPicker />
          </div>
        ) : null}

        <div>
          <button
            className="btn-mint"
            disabled={!ready || busy}
            style={!ready || busy ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            onClick={() => void submit()}
          >
            {busy ? "Waiting for your wallet…" : "Sign and publish"}
          </button>
        </div>
      </div>
    </>
  );
}
