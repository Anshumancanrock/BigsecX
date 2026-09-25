import { afterEach, describe, expect, mock, test } from "bun:test";

/*
 * `fetchSwapInstructions` is a free function that packages/tx imports from
 * @ps/market directly, so a fake JupiterClient cannot intercept it; the
 * module is mocked instead.
 */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
await mock.module("@ps/market", () => {
  const actual = require("../../../packages/market/src/index.ts");
  return {
    ...actual,
    fetchSwapInstructions: async () => {
      // SetComputeUnitPrice is discriminator 0x03 followed by a
      // little-endian u64; the packer reads the fee straight out of it.
      const price = Buffer.alloc(9);
      price[0] = 0x03;
      price.writeBigUInt64LE(50_000n, 1);
      return {
        computeBudgetInstructions: [
          { programId: COMPUTE_BUDGET, accounts: [], data: price.toString("base64") },
        ],
        setupInstructions: [],
        swapInstruction: {
          programId: SYSTEM_PROGRAM,
          accounts: [{ pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }],
          data: Buffer.alloc(8).toString("base64"),
        },
        cleanupInstruction: null,
        otherInstructions: [],
        addressLookupTableAddresses: [],
        computeUnitLimit: 120_000,
        simulationError: null,
      };
    },
  };
});

import { createApp } from "../src/app.ts";
import { makeServices, type FakeOptions } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

const WALLET = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const raw = (uiAmount: number, multiplier = 1) => BigInt(Math.round((uiAmount / multiplier) * 1e9));

function app(options: FakeOptions = {}) {
  const services = makeServices(options);
  open.push(services.store);
  return { app: createApp(services), services };
}

const post = (a: ReturnType<typeof createApp>, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/*
 * Sales go through their own routes: the mirror endpoint moves a wallet
 * toward a target allocation, so selling one position there would spend the
 * proceeds on the others.
 */
describe("POST /api/exit/plan", () => {
  const holder: FakeOptions = {
    balances: { OPENAI: raw(1), ANTHROPIC: raw(2) },
    priceUsd: { OPENAI: 200, ANTHROPIC: 150 },
  };

  test("sells everything held, and says what the proceeds are", async () => {
    const res = await post(app(holder).app, "/api/exit/plan", { owner: WALLET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sells: { symbol: string; usd: number }[]; proceedsUsd: number };

    expect(body.sells.map((s) => s.symbol).sort()).toEqual(["ANTHROPIC", "OPENAI"]);
    // OpenAI carries a 1.4861347x multiplier, so raw(1) is 1.486 UI shares
    // at $200, plus 2 shares of Anthropic at $150.
    expect(body.proceedsUsd).toBeCloseTo(1.4861347 * 200 + 300, 0);
  });

  test("sells only the positions named", async () => {
    const res = await post(app(holder).app, "/api/exit/plan", { owner: WALLET, symbols: ["OPENAI"] });
    const body = (await res.json()) as { sells: { symbol: string; usd: number }[] };
    expect(body.sells).toHaveLength(1);
    expect(body.sells[0]!.symbol).toBe("OPENAI");
  });

  test("sells a fraction, leaving the rest", async () => {
    const res = await post(app(holder).app, "/api/exit/plan", { owner: WALLET, fraction: 0.25 });
    const body = (await res.json()) as { proceedsUsd: number };
    expect(body.proceedsUsd).toBeCloseTo((1.4861347 * 200 + 300) * 0.25, 0);
  });

  test("dust is left alone, and the refusal explains why rather than just failing", async () => {
    // Thirty cents of a token is not worth a transaction. Saying "nothing
    // to sell" without saying why reads as a bug.
    const a = app({ balances: { OPENAI: raw(0.001) }, priceUsd: { OPENAI: 200 } });
    const res = await post(a.app, "/api/exit/plan", { owner: WALLET });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; skipped: { symbol: string; reason: string }[] };
    expect(body.error).toContain("nothing worth selling");
    expect(body.skipped[0]!.symbol).toBe("OPENAI");
    expect(body.skipped[0]!.reason).toContain("too small");
  });

  test("a small position a basket left behind can still be sold", async () => {
    /*
     * The sell floor sits below the $5 purchase minimum: a basket's smallest
     * slice is bought at about $5 and is worth slightly less after the fee and
     * spread, and it must still be sellable.
     */
    const a = app({ balances: { POLYMARKET: raw(4.7) }, priceUsd: { POLYMARKET: 1 } });
    const res = await post(a.app, "/api/exit/plan", { owner: WALLET });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { proceedsUsd: number }).proceedsUsd).toBeCloseTo(4.7, 1);
  });

  test("a frozen position is blocked, not skipped — the difference matters", async () => {
    // "Skipped" means the server chose not to; "blocked" means the wallet cannot.
    // Someone trying to exit needs to know which.
    const a = app({ ...holder, frozen: ["OPENAI"] });
    const res = await post(a.app, "/api/exit/plan", { owner: WALLET });
    const body = (await res.json()) as {
      sells: { symbol: string }[];
      blocked: { symbol: string; reason: string }[];
    };
    expect(body.sells.map((s) => s.symbol)).toEqual(["ANTHROPIC"]);
    expect(body.blocked[0]!.symbol).toBe("OPENAI");
    expect(body.blocked[0]!.reason).toContain("frozen");
  });

  test("the floor applies per position, not to the total", async () => {
    /*
     * The floor applies per position, not to the total: three $1.50 positions
     * sold at half are $2.25 in total but $0.75 each, so nothing is sold. The
     * client asks this endpoint rather than estimating.
     */
    const a = app({
      balances: { ANTHROPIC: raw(1.5), KALSHI: raw(1.5), POLYMARKET: raw(1.5) },
      priceUsd: { ANTHROPIC: 1, KALSHI: 1, POLYMARKET: 1 },
    });
    const whole = await post(a.app, "/api/exit/plan", { owner: WALLET, fraction: 1 });
    expect(whole.status).toBe(200);
    expect(((await whole.json()) as { proceedsUsd: number }).proceedsUsd).toBeCloseTo(4.5, 1);

    const half = await post(a.app, "/api/exit/plan", { owner: WALLET, fraction: 0.5 });
    expect(half.status).toBe(400);
    const body = (await half.json()) as { skipped: { symbol: string }[] };
    expect(body.skipped).toHaveLength(3);
  });

  test("an empty wallet says so plainly", async () => {
    const res = await post(app().app, "/api/exit/plan", { owner: WALLET });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("nothing worth selling");
  });

  test("validates its inputs", async () => {
    const a = app(holder).app;
    expect((await post(a, "/api/exit/plan", { owner: "nope" })).status).toBe(400);
    expect((await post(a, "/api/exit/plan", { owner: WALLET, fraction: 0 })).status).toBe(400);
    expect((await post(a, "/api/exit/plan", { owner: WALLET, fraction: 1.5 })).status).toBe(400);
    expect((await post(a, "/api/exit/plan", { owner: WALLET, fraction: true })).status).toBe(400);
    expect((await post(a, "/api/exit/plan", { owner: WALLET, symbols: ["NOPE"] })).status).toBe(400);
    expect((await post(a, "/api/exit/plan", { owner: WALLET, symbols: [] })).status).toBe(400);
  });
});

describe("POST /api/exit/build", () => {
  const holder: FakeOptions = {
    balances: { OPENAI: raw(1), ANTHROPIC: raw(2) },
    priceUsd: { OPENAI: 200, ANTHROPIC: 150 },
  };

  test("builds unsigned transactions that sell, with no buy legs", async () => {
    const res = await post(app(holder).app, "/api/exit/build", { owner: WALLET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      transactions: string[];
      legs: { symbol: string; side: string }[];
      scope: string;
    };
    expect(body.transactions.length).toBeGreaterThan(0);
    // Every leg is a sale; a buy would mean the proceeds were being reinvested.
    expect(body.legs.every((l) => l.side === "sell")).toBe(true);
    expect(body.scope).toContain("USDC");
  });

  test("the not-atomic guard cannot fire, because a sale funds nothing", async () => {
    const res = await post(app(holder).app, "/api/exit/build", { owner: WALLET });
    expect(res.status).not.toBe(409);
  });

  test("a sell with no SOL is refused, because a sale still pays a fee", async () => {
    /*
     * The SOL check must run for pure sells too, or a wallet without SOL would be
     * handed a bundle it can never submit.
     */
    const a = app({ ...holder, lamports: 0 });
    const res = await post(a.app, "/api/exit/build", { owner: WALLET });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { problems: { kind: string }[] };
    expect(body.problems.map((p) => p.kind)).toContain("insufficient-sol");
  });

  test("a sell is NOT refused for USDC, which only a buy spends", async () => {
    const a = app({ ...holder, usdcRaw: 0n });
    const res = await post(a.app, "/api/exit/build", { owner: WALLET });
    const body = (await res.json()) as { problems?: { kind: string }[] };
    expect((body.problems ?? []).map((p) => p.kind)).not.toContain("insufficient-usdc");
  });

  test("a wallet with nothing sellable is refused before anything is built", async () => {
    const a = app();
    const res = await post(a.app, "/api/exit/build", { owner: WALLET });
    expect(res.status).toBe(400);
    expect(a.services.jupiter.calls ?? []).not.toContain("swap-instructions");
  });
});
