/**
 * The app behind the landing page: providers, the frame (tab bar on phones,
 * header and sidebar on desktop) and the routed page. The market snapshot is
 * polled once here and shared through MarketContext.
 */

import { useEffect, useRef } from "react";
import { ToastProvider, useToast } from "../components/Toast.tsx";
import { OwnAvatar } from "../features/people/Face.tsx";
import { useWallet } from "../features/wallet/WalletContext.tsx";
import { api, type Market } from "../lib/api.ts";
import { MarketContext } from "../lib/market.ts";
import { usePhone } from "../lib/phone.ts";
import { useAsync } from "../lib/useAsync.ts";
import { DeskFrame } from "./DeskFrame.tsx";
import { Routed, titleFor } from "./routes.tsx";
import { TabBar } from "./TabBar.tsx";
import "../styles/app.css";
import "../styles/phone.css";
import "../styles/covers.css";
import "../styles/people.css";
import "../styles/desk.css";

/** The API keeps the snapshot a few seconds fresh while anyone polls it. */
const MARKET_POLL_MS = 5_000;

export function AppShell({ path }: { path: string }) {
  const market = useAsync<Market>((signal) => api.market(signal), [], { pollMs: MARKET_POLL_MS });
  const phone = usePhone();

  useEffect(() => {
    const section = titleFor(path);
    document.title = section ? `${section} · BasketX` : "BasketX";
  }, [path]);

  return (
    <MarketContext.Provider value={market.data}>
      <ToastProvider>
        <WalletToasts />
        <OwnAvatar />
        <div className={`app ${phone ? "is-phone" : "is-desk"}`}>
          <div className="app-glow" aria-hidden="true" />
          {phone ? <TabBar path={path} /> : <DeskFrame path={path} />}
          <div className="main">
            <div className="content">
              {market.error ? (
                <div className="banner bad">
                  <span>Prices could not be loaded just now. This page will retry on its own.</span>
                </div>
              ) : null}
              {market.data?.degraded?.length ? (
                <div className="banner">
                  <span>Some price sources are slow right now, so a few prices may be a little out of date.</span>
                </div>
              ) : null}
              <Routed path={path} market={market.data} loading={market.loading} phone={phone} />
            </div>
          </div>
        </div>
      </ToastProvider>
    </MarketContext.Provider>
  );
}

/** Wallet popups connect out of sight, so say when a wallet connects or disconnects. */
function WalletToasts() {
  const wallet = useWallet();
  const toast = useToast();
  const opened = useRef(Date.now());
  const last = useRef(wallet.address);
  useEffect(() => {
    const before = last.current;
    last.current = wallet.address;
    // The silent reconnect right after load is not worth announcing.
    if (before === wallet.address || Date.now() - opened.current < 2500) return;
    if (wallet.address) {
      toast(`Connected ${wallet.walletName ?? "wallet"} · ${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`, "good");
    } else if (before) {
      toast("Wallet disconnected");
    }
  }, [wallet.address, wallet.walletName, toast]);
  return null;
}
