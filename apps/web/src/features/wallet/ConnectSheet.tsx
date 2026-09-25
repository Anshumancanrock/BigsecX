import { useEffect, useState } from "react";
import { Sheet } from "../../components/Sheet.tsx";
import { WalletPicker } from "./ConnectButton.tsx";
import { useWallet } from "./WalletContext.tsx";

export function ConnectSheet({ onClose }: { onClose: () => void }) {
  const wallet = useWallet();
  useEffect(() => {
    if (wallet.address) onClose();
  }, [wallet.address, onClose]);
  return (
    <Sheet title="Connect a wallet" onClose={onClose}>
      <p className="note" style={{ marginBottom: 12 }}>
        Your wallet holds your money and signs every trade. Nothing is signed until you have seen the exact price.
      </p>
      <div className="inline-picker">
        <WalletPicker />
      </div>
    </Sheet>
  );
}

export function ConnectSheetButton({ className = "btn-mint", label = "Connect wallet" }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? <ConnectSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}
