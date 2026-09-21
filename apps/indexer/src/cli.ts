/**
 * Print a market snapshot. Doubles as the smoke test for the whole read path:
 * if this prints sane numbers, RPC, mint parsing, scaling, fee selection and
 * the price feed are all wired correctly.
 */

import { Rpc } from "@ps/chain";
import { JupiterClient } from "@ps/market";
import { takeSnapshot } from "@ps/market";

const RPC_URL = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";

const rpc = new Rpc({ url: RPC_URL });
const jupiter = new JupiterClient();

const snapshot = await takeSnapshot(rpc, jupiter);

const pct = (value: number | null, digits = 2) =>
  value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
const usd = (value: number | null) =>
  value === null ? "—" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

console.log(`\nPreStocks market — ${snapshot.takenAt.toISOString()}  epoch ${snapshot.epoch}`);
console.log("─".repeat(104));
console.log(
  ["SYMBOL".padEnd(11), "MARKET".padStart(11), "MARK".padStart(11), "BASIS".padStart(9),
   "LABEL".padStart(15), "LIQUIDITY".padStart(13), "24H".padStart(8), "MULT".padStart(10), "FEE"].join(" "),
);

for (const t of [...snapshot.tokens].sort((a, b) => (a.basis ?? 0) - (b.basis ?? 0))) {
  console.log(
    [
      t.token.symbol.padEnd(11),
      usd(t.marketUsd).padStart(11),
      usd(t.markUsd).padStart(11),
      pct(t.basis).padStart(9),
      (t.basisLabel ?? "—").padStart(15),
      usd(t.liquidityUsd).padStart(13),
      `${t.change24hPct.toFixed(2)}%`.padStart(8),
      `x${t.multiplier}`.padStart(10),
      `${t.transferFeeBps}bps${t.paused ? " PAUSED" : ""}`,
    ].join(" "),
  );
}

console.log("─".repeat(104));
console.log(`Total quotable DEX liquidity: ${usd(snapshot.totalLiquidityUsd)}`);

if (snapshot.pendingFeeChange) {
  const { fromBps, toBps, atEpoch } = snapshot.pendingFeeChange;
  console.log(
    `Transfer fee rises ${fromBps}bps -> ${toBps}bps at epoch ${atEpoch} ` +
      `(${atEpoch - snapshot.epoch === 1 ? "next epoch" : `${atEpoch - snapshot.epoch} epochs away`}). Quoting ${toBps}bps today would be wrong.`,
  );
}
if (snapshot.degraded.length > 0) {
  console.log(`Incomplete data for: ${snapshot.degraded.join(", ")}`);
}
console.log();
