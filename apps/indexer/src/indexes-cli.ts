/**
 * Build every thematic index from live market data and price one of them for
 * execution against real quotes.
 *
 * This is the end-to-end check for the write path: universe -> mint state ->
 * prices -> index weights -> rebalance orders -> depth-checked execution plan.
 */

import {
  INDEX_DEFINITIONS,
  buildIndex,
  definitionById,
  planRebalance,
  transferFeeCostUsd,
  type IndexInput,
} from "@ps/core";
import { Rpc } from "@ps/chain";
import { JupiterClient, buildExecutionPlan } from "@ps/market";
import { takeSnapshot } from "@ps/market";

const RPC_URL = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
const priceIndexId = process.argv[2] ?? "pre8";
const deployUsd = Number(process.argv[3] ?? 1_000);

const rpc = new Rpc({ url: RPC_URL });
const jupiter = new JupiterClient();
const snapshot = await takeSnapshot(rpc, jupiter);

const inputs: IndexInput[] = snapshot.tokens.map((t) => ({
  symbol: t.token.symbol,
  sectors: t.token.sectors,
  // Implied valuation is the market's view of the company, which is what a
  // valuation-weighted index should track: supply in UI shares times price.
  impliedValuationUsd: t.marketUsd === null ? null : t.marketUsd * t.supplyUi,
  liquidityUsd: t.liquidityUsd,
  basis: t.basis,
}));

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

console.log(`\nIndexes at ${snapshot.takenAt.toISOString()} (epoch ${snapshot.epoch})`);
console.log("═".repeat(96));

for (const definition of INDEX_DEFINITIONS) {
  const portfolio = buildIndex(definition, inputs);
  if (!portfolio) {
    console.log(`\n${definition.name} — no tradable constituents`);
    continue;
  }
  const weights = [...portfolio.weights].sort((a, b) => b.weight - a.weight);
  console.log(`\n${definition.name}  (${definition.id})`);
  console.log(`  ${definition.description}`);
  console.log(`  ${weights.map((w) => `${w.symbol} ${pct(w.weight)}`).join("   ")}`);
}

// Price one index for execution.
const definition = definitionById(priceIndexId);
if (!definition) {
  console.error(`\nUnknown index "${priceIndexId}"`);
  process.exit(1);
}
const portfolio = buildIndex(definition, inputs);
if (!portfolio) {
  console.error(`\nIndex "${priceIndexId}" has no tradable constituents`);
  process.exit(1);
}

const priceUsdBySymbol = new Map<string, number>();
const liquidityUsdBySymbol = new Map<string, number>();
const scaleBySymbol = new Map<string, number>();
for (const t of snapshot.tokens) {
  if (t.marketUsd !== null) priceUsdBySymbol.set(t.token.symbol, t.marketUsd);
  liquidityUsdBySymbol.set(t.token.symbol, t.liquidityUsd);
  scaleBySymbol.set(t.token.symbol, t.multiplier);
}

const rebalance = planRebalance({
  target: portfolio.weights,
  holdings: [],
  priceUsdBySymbol,
  deployUsd,
});

const feeBps = snapshot.tokens[0]?.transferFeeBps ?? 0;

console.log(`\n${"═".repeat(96)}`);
console.log(`Execution plan — ${usd(deployUsd)} into ${definition.name}, quoted live`);
console.log("═".repeat(96));

const plan = await buildExecutionPlan(jupiter, {
  orders: rebalance.orders,
  liquidityUsdBySymbol,
  priceUsdBySymbol,
  scaleBySymbol,
  transferFeeBps: feeBps,
});

console.log(
  ["SIDE".padEnd(5), "SYMBOL".padEnd(11), "SIZE".padStart(11), "SHARES".padStart(11),
   "FILL".padStart(11), "REF".padStart(11), "COST".padStart(8), "NOTE"].join(" "),
);
for (const leg of plan.legs) {
  console.log(
    [
      leg.order.side.padEnd(5),
      leg.order.symbol.padEnd(11),
      usd(leg.usd).padStart(11),
      (leg.expectedOutUi === null ? "—" : leg.expectedOutUi.toFixed(4)).padStart(11),
      (leg.effectivePriceUsd === null ? "—" : usd(leg.effectivePriceUsd)).padStart(11),
      (leg.referencePriceUsd === null ? "—" : usd(leg.referencePriceUsd)).padStart(11),
      (leg.costVsReference === null ? "—" : pct(leg.costVsReference)).padStart(8),
      leg.note ?? "",
    ].join(" "),
  );
}
for (const d of plan.deferred) {
  console.log(`DEFER ${d.symbol.padEnd(11)} ${usd(d.usd).padStart(12)}           — ${d.reason}`);
}

console.log("─".repeat(96));
console.log(
  `Deployed ${usd(plan.totalUsd)} of ${usd(deployUsd)} · ` +
    `realized cost ${usd(plan.totalCostUsd)} (${pct(plan.costFraction)}), ` +
    `of which ${usd(plan.totalTransferFeeUsd)} is the ${feeBps}bps transfer fee already inside the quote.`,
);
if (snapshot.pendingFeeChange) {
  const { fromBps, toBps, atEpoch } = snapshot.pendingFeeChange;
  const after = plan.legs.reduce((sum, l) => sum + transferFeeCostUsd(l.usd, toBps), 0);
  console.log(
    `At epoch ${atEpoch} the fee goes ${fromBps}bps -> ${toBps}bps and the same basket pays ${usd(after)}.`,
  );
}
console.log();
