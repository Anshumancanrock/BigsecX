/**
 * Connect/disconnect and the wallet picker. Four cases are told apart because
 * each has a different fix: connected, no wallet on desktop, no wallet on a
 * phone, and an installed wallet that predates the Wallet Standard. The
 * picker is exported so sheets can offer it inline.
 */

import { useEffect, useRef, useState } from "react";
import { useWallet } from "./WalletContext.tsx";
import { shortAddress } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";
import { Face } from "../people/Face.tsx";

export function ConnectButton() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const pickedHere = useRef(false);
  useEffect(() => {
    if (!wallet.error) return;
    if (pickedHere.current) setOpen(true);
    pickedHere.current = false;
  }, [wallet.error]);
  useEffect(() => {
    if (wallet.address) pickedHere.current = false;
  }, [wallet.address]);

  const [copied, setCopied] = useState(false);

  return (
    <div className="wallet-box" ref={box}>
      {wallet.address ? (
        <button className="profile" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
          <Face wallet={wallet.address} size={28} />
          <span className="profile-text">
            <b className="num">{shortAddress(wallet.address, 4, 4)}</b>
            <small>{wallet.walletName ?? "Wallet"}</small>
          </span>
        </button>
      ) : (
        <button
          className="btn-mint"
          onClick={() => setOpen((v) => !v)}
          disabled={wallet.connecting}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          {wallet.connecting ? (
            "Connecting…"
          ) : (
            // One child, so the button's flex gap does not open between words.
            <span>
              Connect<span className="wide-only"> wallet</span>
            </span>
          )}
        </button>
      )}

      {open ? (
        <div className="wallet-menu" role="menu">
          {wallet.address ? (
            <>
              <div className="wallet-row" style={{ color: "hsl(var(--fg-muted))", fontSize: 12 }}>
                Connected with {wallet.walletName}
              </div>
              <a
                className="wallet-row"
                href="/portfolio"
                onClick={(event) => {
                  event.preventDefault();
                  setOpen(false);
                  navigate("/portfolio");
                }}
              >
                Open
              </a>
              <button
                className="wallet-row"
                onClick={() => {
                  void navigator.clipboard?.writeText(wallet.address!).then(() => setCopied(true));
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy address"}
              </button>
              <button
                className="wallet-row danger"
                onClick={() => {
                  void wallet.disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <WalletPicker
              onPicked={() => {
                pickedHere.current = true;
                setOpen(false);
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * True on a phone or tablet, where browsers have no wallet extensions. iPadOS
 * reports itself as a Mac, so a coarse pointer counts too.
 */
function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return coarse && navigator.maxTouchPoints > 0;
}

/**
 * Opens this page in a wallet app's in-app browser. Mobile Safari and Chrome
 * cannot run wallet extensions; the wallet apps publish deep links for this.
 */
function openInWallet(kind: "phantom" | "solflare"): string {
  const here = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  return kind === "phantom"
    ? `https://phantom.app/ul/browse/${here}?ref=${ref}`
    : `https://solflare.com/ul/v1/browse/${here}?ref=${ref}`;
}

export function WalletPicker({ onPicked }: { onPicked?: () => void }) {
  const wallet = useWallet();

  return (
    <>
      {wallet.error ? (
        <div className="wallet-row" style={{ display: "block", color: "hsl(var(--down))", fontSize: 12.5 }}>
          Could not connect: {wallet.error}
        </div>
      ) : null}

      {wallet.wallets.length > 0 ? (
        wallet.wallets.map((w) => (
          <button
            className="wallet-row"
            key={w.name}
            onClick={() => {
              wallet.dismissError();
              void wallet.connect(w.name);
              onPicked?.();
            }}
          >
            {w.icon ? (
              <img src={w.icon} alt="" />
            ) : (
              <span className="glyph" aria-hidden="true">
                {w.name.slice(0, 1)}
              </span>
            )}
            {w.name}
          </button>
        ))
      ) : wallet.legacyOnly ? (
        <div className="wallet-row" style={{ display: "block", color: "hsl(var(--fg-muted))", fontSize: 12.5 }}>
          A wallet is installed but it is too old to connect here. Updating the extension should fix it.
        </div>
      ) : isMobile() ? (
        <>
          <div className="wallet-row" style={{ display: "block", color: "hsl(var(--fg-muted))", fontSize: 12.5 }}>
            Phone browsers cannot connect to a wallet directly. Open this page inside your wallet app instead:
          </div>
          <a className="wallet-row" href={openInWallet("phantom")}>
            Open in Phantom
          </a>
          <a className="wallet-row" href={openInWallet("solflare")}>
            Open in Solflare
          </a>
          <a className="wallet-row" href="https://phantom.com/download" target="_blank" rel="noreferrer noopener">
            No wallet app yet? Get Phantom
          </a>
        </>
      ) : (
        <>
          <div className="wallet-row" style={{ display: "block", color: "hsl(var(--fg-muted))", fontSize: 12.5 }}>
            You need a Solana wallet. It is a free browser extension, and it keeps your money in your control.
          </div>
          <a className="wallet-row" href="https://phantom.com/download" target="_blank" rel="noreferrer noopener">
            Get Phantom
          </a>
          <a className="wallet-row" href="https://solflare.com/download/" target="_blank" rel="noreferrer noopener">
            Get Solflare
          </a>
          <div className="wallet-row" style={{ display: "block", color: "hsl(var(--fg-faint))", fontSize: 12 }}>
            Installed one? Reload this page.
          </div>
        </>
      )}
    </>
  );
}
