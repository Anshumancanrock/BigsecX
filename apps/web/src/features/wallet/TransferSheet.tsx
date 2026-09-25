/**
 * Deposit and withdraw. Funds never leave the user's wallet, so a deposit is
 * USDC sent to its own address and a withdrawal happens in the wallet app.
 */

import { useState } from "react";
import { api, type Cash } from "../../lib/api.ts";
import { usd } from "../../lib/format.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { useWallet } from "./WalletContext.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { WalletPicker } from "./ConnectButton.tsx";
import { FundingHelp } from "./FundingHelp.tsx";
import { go } from "../../lib/router.ts";

export function TransferSheet({ onClose, initial = "in" }: { onClose: () => void; initial?: "in" | "out" }) {
  const wallet = useWallet();
  const toast = useToast();
  const [side, setSide] = useState<"in" | "out">(initial);
  const cash = useAsync<Cash | null>(
    (signal) => (wallet.address ? api.cash(wallet.address, signal) : Promise.resolve(null)),
    [wallet.address],
  );

  if (!wallet.address) {
    return (
      <Sheet title="Connect a wallet" onClose={onClose}>
        <p className="note" style={{ marginBottom: 12 }}>
          Your money stays in your own wallet. Connect it to see its address and what it holds.
        </p>
        <div className="inline-picker">
          <WalletPicker />
        </div>
      </Sheet>
    );
  }

  const shareAddress = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "My Solana address", text: wallet.address! });
        return;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(wallet.address!);
      toast("Address copied", "good");
    } catch {
      toast(wallet.address!);
    }
  };

  const sol = cash.data ? cash.data.solLamports / 1e9 : null;

  return (
    <Sheet title="Transfer" onClose={onClose}>
      <Segmented
        className="sheet-seg"
        label="Add or withdraw"
        options={[
          { value: "in", label: "Add funds" },
          { value: "out", label: "Withdraw" },
        ]}
        value={side}
        onChange={setSide}
      />

      <div className="transfer-balances">
        <span>
          <small>USDC</small>
          <b className="num">{cash.data ? usd(cash.data.usdcUsd) : "—"}</b>
        </span>
        <span>
          <small>SOL for fees</small>
          <b className="num">{sol === null ? "—" : sol.toFixed(4)}</b>
        </span>
      </div>

      {side === "in" ? (
        <>
          <FundingHelp
            address={wallet.address}
            needUsdc
            needSol={sol === null || sol < 0.01}
            after="Usually arrives within a minute or two."
          />
          <button className="btn-soft wide" style={{ marginTop: 10 }} onClick={() => void shareAddress()}>
            Share my address
          </button>
        </>
      ) : (
        <div className="funding">
          <p>
            <b>Your money is already in your wallet.</b> Nothing is held here: every company you buy lands in your own
            wallet, and every sale pays USDC back to it.
          </p>
          <p>
            To take money out, first sell what you want to turn into cash — from your profile or a company's page. Then
            send the USDC from your wallet app to an exchange or anywhere else, on the Solana network.
          </p>
          <a className="btn-soft wide" href="/portfolio" onClick={(event) => {
            onClose();
            go("/portfolio")(event);
          }}>
            See what I can sell
          </a>
        </div>
      )}
    </Sheet>
  );
}
