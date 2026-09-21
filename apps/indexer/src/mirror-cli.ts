/**
 * Build a real mirror bundle for a wallet and simulate every transaction
 * against mainnet.
 *
 * Nothing is signed or sent. Simulation is the honest end-to-end check: it
 * runs the exact bytes a wallet would sign, against real account state, and
 * reports whether they would land.
 */

import { INDEX_DEFINITIONS, buildIndex, definitionById, planRebalance, type IndexInput } from "@ps/core";
import { Rpc } from "@ps/chain";
import { JupiterClient } from "@ps/market";
import { buildMirrorBundle } from "@ps/tx";
import { takeSnapshot } from "@ps/market";

const RPC_URL = process.env["SOLANA_RPC_URL"] ?? "https://solana-rpc.publicnode.com";
const owner = process.argv[2];
const indexId = process.argv[3] ?? "pre8";
const deployUsd = Number(process.argv[4] ?? 500);

if (!owner) {
  console.error("usage: bun run apps/indexer/src/mirror-cli.ts <wallet> [indexId] [usd]");
  console.error(`indexes: ${INDEX_DEFINITIONS.map((d) => d.id).join(", ")}`);
  process.exit(1);
}

const rpc = new Rpc({ url: RPC_URL });
const jupiter = new JupiterClient();
const snapshot = await takeSnapshot(rpc, jupiter);

const inputs: IndexInput[] = snapshot.tokens.map((t) => ({
  symbol: t.token.symbol,
  sectors: t.token.sectors,
  impliedValuationUsd: t.marketUsd === null ? null : t.marketUsd * t.supplyUi,
  liquidityUsd: t.liquidityUsd,
  basis: t.basis,
}));

const definition = definitionById(indexId);
if (!definition) throw new Error(`unknown index ${indexId}`);
const portfolio = buildIndex(definition, inputs);
if (!portfolio) throw new Error(`index ${indexId} has no tradable constituents`);

const priceUsdBySymbol = new Map<string, number>();
const scaleBySymbol = new Map<string, number>();
for (const t of snapshot.tokens) {
  if (t.marketUsd !== null) priceUsdBySymbol.set(t.token.symbol, t.marketUsd);
  scaleBySymbol.set(t.token.symbol, t.multiplier);
}

const rebalance = planRebalance({
  target: portfolio.weights,
  holdings: [],
  priceUsdBySymbol,
  deployUsd,
});

const { blockhash, lastValidBlockHeight } = (
  await rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
    "getLatestBlockhash",
    [{ commitment: "finalized" }],
  )
).value;

console.log(`\nMirroring ${definition.name} — $${deployUsd} for ${owner}`);
console.log(`${rebalance.orders.length} legs, blockhash ${blockhash.slice(0, 12)}…\n`);

const bundle = await buildMirrorBundle(jupiter, {
  owner,
  legs: rebalance.orders.map((o) => ({ symbol: o.symbol, side: o.side, usd: o.usd })),
  priceUsdBySymbol,
  scaleBySymbol,
  blockhash,
  lastValidBlockHeight,
});

console.log(`Packed into ${bundle.transactions.length} transaction(s):`);
bundle.legsByTransaction.forEach((symbols, i) => {
  console.log(`  tx ${i + 1}: ${String(bundle.byteLengths[i]).padStart(4)} bytes  ${symbols.join(", ")}`);
});
for (const failure of bundle.failed) {
  console.log(`  FAILED ${failure.symbol}: ${failure.reason}`);
}

console.log("\nSimulating each transaction against mainnet:");
let ok = 0;
for (const [i, encoded] of bundle.transactions.entries()) {
  const result = await rpc.call<{
    value: { err: unknown; unitsConsumed?: number; logs?: string[] };
  }>("simulateTransaction", [
    encoded,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" },
  ]);

  const { err, unitsConsumed, logs } = result.value;
  if (err === null) {
    ok++;
    console.log(`  tx ${i + 1}: OK    ${unitsConsumed ?? "?"} CU`);
  } else {
    console.log(`  tx ${i + 1}: ERROR ${JSON.stringify(err)}`);
    for (const line of (logs ?? []).slice(-4)) console.log(`         ${line.slice(0, 120)}`);
  }
}
console.log(`\n${ok}/${bundle.transactions.length} transactions would land.\n`);
