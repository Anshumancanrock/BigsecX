/**
 * Indexer entrypoint. Runs the job once, then on an interval.
 */

import { Rpc } from "@ps/chain";
import { JupiterClient } from "@ps/market";
import { Store } from "@ps/db";
import { runJob } from "./job.ts";

const RPC_URL = process.env["SOLANA_RPC_URL"] ?? "https://solana-rpc.publicnode.com";
const INTERVAL_MS = Number(process.env["INDEXER_INTERVAL_MS"] ?? 5 * 60_000);

const rpc = new Rpc({ url: RPC_URL });
const jupiter = new JupiterClient();
const store = new Store();

/**
 * True while a pass is running.
 *
 * A pass took 143 seconds under rate limiting against a shorter interval, so
 * overlap is not theoretical. Two passes at once double the request pressure
 * that caused the slowness, and both read the same cursors before either
 * writes, so the second re-indexes the window the first is already handling.
 */
let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.log(`[${new Date().toISOString()}] previous pass still running; skipping this tick`);
    return;
  }
  running = true;
  const started = Date.now();
  try {
    const result = await runJob(rpc, jupiter, store);
    console.log(
      `[${new Date().toISOString()}] snapshot ${result.snapshotId} · ` +
        `epoch ${result.snapshot.epoch} · +${result.tradesWritten} trades ` +
        `from ${result.tradersSeen} wallets · ${result.indexesWritten} indexes · ` +
        `${Date.now() - started}ms` +
        (result.missedSignatures > 0 ? ` · ${result.missedSignatures} signatures retried next pass` : "") +
        (result.skippedBacklog > 0 ? ` · ${result.skippedBacklog} addresses left a backlog gap` : "") +
        (result.tradeError ? ` · trades degraded: ${result.tradeError}` : ""),
    );
  } catch (error) {
    // A failed tick must not kill the loop: upstreams rate limit, and the
    // next run will pick up where this one left off.
    console.error(`[${new Date().toISOString()}] job failed:`, (error as Error).message);
  } finally {
    running = false;
  }
}

await tick();
if (process.env["INDEXER_ONCE"] !== "1") {
  setInterval(() => void tick(), INTERVAL_MS);
  console.log(`indexer running every ${INTERVAL_MS / 1000}s`);
}
