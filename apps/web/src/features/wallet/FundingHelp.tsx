/**
 * How to fund the wallet: its address with a copy button, and the network to
 * choose, since a withdrawal on the wrong network loses the deposit.
 */

import { useState } from "react";

export function FundingHelp({
  address,
  needUsdc,
  needSol,
  solAmount = "about 0.02 SOL",
  after = "Try again once it arrives, usually within a minute or two.",
}: {
  address: string;
  needUsdc: boolean;
  needSol: boolean;
  solAmount?: string;
  after?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="funding">
      {needUsdc ? (
        <p>
          <b>Send USDC on the Solana network</b> to this address. Other networks will not arrive.
        </p>
      ) : null}
      {needSol ? (
        <p>
          <b>Add {solAmount}</b> for network fees.
        </p>
      ) : null}

      <div className="funding-address">
        <span className="tile-note" style={{ display: "block", marginBottom: 4 }}>
          Your wallet address
        </span>
        <code>{address}</code>
        <button
          className="btn-ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="note" style={{ marginTop: 8 }}>
        {after}
      </p>
    </div>
  );
}
