/**
 * Wallet state for the app: one live connection, its address and name; the
 * protocol lives in lib/wallet.ts. On load it reconnects silently, and a
 * wallet that has not authorised this origin stays disconnected without a popup.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  availableWallets,
  connect as connectWallet,
  isUserRejection,
  hasLegacyOnlyWallet,
  onWalletsChanged,
  startDiscovery,
  type Connection,
  type WalletInfo,
} from "../../lib/wallet.ts";

const REMEMBERED = "bx-wallet";

export interface WalletState {
  readonly address: string | null;
  readonly walletName: string | null;
  readonly connection: Connection | null;
  readonly wallets: readonly WalletInfo[];
  readonly connecting: boolean;
  readonly error: string | null;
  readonly legacyOnly: boolean;
  connect(name: string): Promise<void>;
  disconnect(): Promise<void>;
  dismissError(): void;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const state = useContext(Ctx);
  if (!state) throw new Error("useWallet outside WalletProvider");
  return state;
}

function remember(name: string | null): void {
  try {
    if (name) localStorage.setItem(REMEMBERED, name);
    else localStorage.removeItem(REMEMBERED);
  } catch {
    // Private browsing. Losing the preference is not worth an error.
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallets, setWallets] = useState<readonly WalletInfo[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the unmount cleanup below sees the current value
  // without making every effect depend on the connection object.
  const connectionRef = useRef<Connection | null>(null);
  connectionRef.current = connection;

  useEffect(() => {
    startDiscovery();
    setWallets(availableWallets());
    return onWalletsChanged(() => setWallets(availableWallets()));
  }, []);

  const attach = useCallback((next: Connection) => {
    setConnection(next);
    setAddress(next.address);
    remember(next.walletName);
    // A wallet can switch account or lock at any time. Treating a null
    // address as "still connected" is how an app ends up building a
    // transaction for a wallet the user has walked away from.
    next.onChange((changed) => {
      setAddress(changed);
      if (!changed) {
        setConnection(null);
        remember(null);
      }
    });
  }, []);

  // Silent reconnect, once, after discovery has had a chance to find wallets.
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || wallets.length === 0) return;
    tried.current = true;

    let name: string | null = null;
    try {
      name = localStorage.getItem(REMEMBERED);
    } catch {
      return;
    }
    if (!name || !wallets.some((w) => w.name === name)) return;

    let live = true;
    connectWallet(name, { silent: true })
      .then((next) => {
        if (live) attach(next);
      })
      .catch(() => {
        // Not authorised any more. Staying signed out is the right answer.
        remember(null);
      });
    return () => {
      live = false;
    };
  }, [wallets, attach]);

  const connect = useCallback(
    async (name: string) => {
      setConnecting(true);
      setError(null);
      try {
        attach(await connectWallet(name));
      } catch (cause) {
        // A dismissed popup is a choice, not a failure worth shouting about.
        setError(isUserRejection(cause) ? null : (cause as Error).message);
      } finally {
        setConnecting(false);
      }
    },
    [attach],
  );

  const disconnect = useCallback(async () => {
    await connectionRef.current?.disconnect();
    setConnection(null);
    setAddress(null);
    setError(null);
    remember(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address,
      walletName: connection?.walletName ?? null,
      connection,
      wallets,
      connecting,
      error,
      legacyOnly: wallets.length === 0 && hasLegacyOnlyWallet(),
      connect,
      disconnect,
      dismissError: () => setError(null),
    }),
    [address, connection, wallets, connecting, error, connect, disconnect],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
