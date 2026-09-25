/**
 * `bun run start`: builds the web app, then runs the stack with labelled output.
 * Ctrl+C stops everything, and if one process exits the others are stopped.
 *
 *   api      :3111  reads, unsigned builds, signed-transaction relay
 *   indexer         records trades for the Traders page
 *   web      :4000  built site, with /api proxied to the API
 *
 * Environment (Bun also loads `.env`):
 *   SOLANA_RPC_URL     RPC endpoint
 *   INDEXER_RPC_URL    separate RPC endpoint for the indexer
 *   JUPITER_API_KEY    use Jupiter's keyed tier
 *   API_PORT, WEB_PORT (WEB_PORT falls back to PORT)
 *   SKIP_BUILD=1      serve an existing apps/web/.build instead of rebuilding
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const API_PORT = Number(process.env["API_PORT"] ?? 3111);
// PORT is what hosting platforms assign; the site is the public process.
const WEB_PORT = Number(process.env["WEB_PORT"] ?? process.env["PORT"] ?? 4000);
const API_ORIGIN = `http://localhost:${API_PORT}`;

const COLOURS: Record<string, string> = { build: "36", api: "35", indexer: "33", web: "32" };

function label(name: string): string {
  return `\x1b[${COLOURS[name] ?? "37"}m${name.padEnd(7)}\x1b[0m│`;
}

/** Copies a child's output to stdout, one labelled line at a time. */
async function pipe(name: string, stream: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true });
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) console.log(`${label(name)} ${line}`);
  }
  if (carry) console.log(`${label(name)} ${carry}`);
}

/** Refuse to start on a port something else already holds. */
async function assertFree(port: number, what: string): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(800) });
  } catch {
    return;
  }
  console.error(
    `${label("start")} port ${port} (${what}) is already in use. Stop whatever is running there, ` +
      `or choose another with ${what === "api" ? "API_PORT" : "WEB_PORT"}=…`,
  );
  process.exit(1);
}

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(400);
  }
  return false;
}

await assertFree(API_PORT, "api");
await assertFree(WEB_PORT, "web");

// ---- 1. build the web app ------------------------------------------------
// SKIP_BUILD=1 serves a bundle built earlier, e.g. in a Docker build step.
if (process.env["SKIP_BUILD"] !== "1") {
  const build = Bun.spawn(["bun", "run", "build.ts"], {
    cwd: `${ROOT}/apps/web`,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, API_BASE: "" },
  });
  await Promise.all([pipe("build", build.stdout), pipe("build", build.stderr)]);
  if ((await build.exited) !== 0) {
    console.error(`${label("build")} the web build failed; nothing was started.`);
    process.exit(1);
  }
}

// ---- 2. start the three processes -----------------------------------------
const children = [
  {
    name: "api",
    cmd: ["bun", "run", "apps/api/src/server.ts"],
    env: { PORT: String(API_PORT) },
  },
  {
    name: "indexer",
    cmd: ["bun", "run", "apps/indexer/src/index.ts"],
    // The indexer makes hundreds of calls a pass; its own endpoint keeps them
    // off the API's rate limit.
    env: process.env["INDEXER_RPC_URL"] ? { SOLANA_RPC_URL: process.env["INDEXER_RPC_URL"] } : {},
  },
  {
    name: "web",
    cmd: ["bun", "run", "apps/web/preview.ts"],
    env: { PORT: String(WEB_PORT), API_ORIGIN },
  },
].map(({ name, cmd, env }) => {
  const child = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  void pipe(name, child.stdout);
  void pipe(name, child.stderr);
  return { name, child };
});

let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) child.kill();
  // Give them a moment to exit cleanly, then leave.
  setTimeout(() => process.exit(code), 1_500);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

for (const { name, child } of children) {
  void child.exited.then((code) => {
    if (stopping) return;
    console.error(`${label(name)} exited with code ${code}; stopping the rest.`);
    stopAll(code || 1);
  });
}

// ---- 3. say where to go -----------------------------------------------------
const apiUp = await waitFor(`${API_ORIGIN}/health`, 30_000);
const webUp = apiUp && (await waitFor(`http://localhost:${WEB_PORT}/`, 30_000));
if (apiUp && webUp) {
  console.log(
    `\n${label("start")} ready.\n` +
      `${label("start")}   Landing    http://localhost:${WEB_PORT}\n` +
      `${label("start")}   Dashboard  http://localhost:${WEB_PORT}/dashboard\n` +
      `${label("start")}   Ctrl+C stops everything.\n`,
  );
} else if (!stopping) {
  console.error(`${label("start")} the ${apiUp ? "web server" : "API"} did not come up within 30 seconds.`);
  stopAll(1);
}
