import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { withSession, signInError } from "../../lib/session.ts";
import { useWallet } from "../wallet/WalletContext.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { WalletPicker } from "../wallet/ConnectButton.tsx";

export function FollowButton({
  wallet,
  following,
  onChange,
  size = "md",
}: {
  wallet: string;
  following: boolean;
  onChange?: (following: boolean, followers: number | null) => void;
  size?: "sm" | "md" | "icon";
}) {
  const me = useWallet();
  const toast = useToast();
  const [state, setState] = useState(following);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => setState(following), [following]);
  useEffect(() => {
    if (me.address) setConnecting(false);
  }, [me.address]);

  if (me.address === wallet) return null;

  const toggle = async () => {
    if (!me.connection) {
      setConnecting(true);
      return;
    }
    const next = !state;
    setState(next);
    setBusy(true);
    try {
      const result = await withSession(me.connection, (token) => api.follow({ token, followee: wallet, follow: next }));
      setState(result.following);
      onChange?.(result.following, result.followers);
    } catch (error) {
      setState(!next);
      onChange?.(!next, null);
      toast(signInError(error, next ? "follow" : "unfollow"), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className={`follow-btn ${size}${state ? " on" : ""}`}
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={state}
        aria-label={size === "icon" ? (state ? "Following, tap to unfollow" : "Follow") : undefined}
        title={size === "icon" ? (state ? "Following" : "Follow") : undefined}
      >
        {size === "icon" ? (
          state ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="10" cy="8" r="3.4" stroke="currentColor" strokeWidth="2" />
              <path d="M3.8 19c.7-3.2 3.1-5 6.2-5 1.3 0 2.5.3 3.5.9M18.5 13v6M15.5 16h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )
        ) : state ? (
          "Following"
        ) : (
          "Follow"
        )}
      </button>
      {connecting ? (
        <Sheet title="Connect to follow" onClose={() => setConnecting(false)}>
          <p className="note" style={{ marginBottom: 12 }}>
            Following is free and public. Connect your wallet; the first follow asks it to sign a message: no
            transaction, no fee.
          </p>
          <div className="inline-picker">
            <WalletPicker />
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
