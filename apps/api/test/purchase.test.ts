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

const build = (a: ReturnType<typeof createApp>, body: Record<string, unknown>) =>
  a.request("/api/mirror/build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: WALLET, ...body }),
  });

type Built = {
  target: string;
  mode: string;
  legs: { symbol: string; side: string; usd: number }[];
  deferred: { symbol: string; reason: string }[];
  totalUsd: number;
  problems?: { kind: string }[];
};

function app(options: FakeOptions = {}) {
  const services = makeServices(options);
  open.push(services.store);
  return { app: createApp(services), services };
}

describe("companies too small to buy on their own", () => {
  test("are named in the build instead of silently dropped", async () => {
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { OPENAI: 100, SPACEX: 100 } });
    const res = await a.request("/api/mirror/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: WALLET,
        weights: [
          { symbol: "OPENAI", weight: 0.97 },
          { symbol: "SPACEX", weight: 0.03 },
        ],
        deployUsd: 100,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      legs: { symbol: string }[];
      deferred: { symbol: string; reason: string }[];
    };
    expect(body.legs.map((l) => l.symbol)).toEqual(["OPENAI"]);
    const spacex = body.deferred.find((d) => d.symbol === "SPACEX");
    expect(spacex?.reason).toContain("$5.00 minimum");
  });
});

describe("the smallest buy at a spread floor", () => {
  /*
   * Mirrors a mainnet case: $5 of SpaceX quoted 3.13% impact while $25 filled at
   * the same rate. The $25 order is re-quoted smaller, costs the same, and is
   * kept as a spread floor; the $5 order cannot shrink, so it is refused.
   */
  test("is bought when a larger order pays the same rate", async () => {
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { SPACEX: 100 }, priceImpact: { SPACEX: 0.031 } });
    const res = await build(a, { weights: [{ symbol: "SPACEX", weight: 1 }], deployUsd: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Built;
    expect(body.legs.map((l) => [l.symbol, l.usd])).toEqual([["SPACEX", 5]]);
  });

  test("agrees with a larger order of the same company", async () => {
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { SPACEX: 100 }, priceImpact: { SPACEX: 0.031 } });
    const res = await build(a, { weights: [{ symbol: "SPACEX", weight: 1 }], deployUsd: 25 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Built).legs[0]!.usd).toBeCloseTo(25, 6);
  });

  test("is bought in a thin pool too, since no smaller order is possible", async () => {
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { SPACEX: 100 }, impactPerUsd: { SPACEX: 0.006 } });
    const res = await build(a, { weights: [{ symbol: "SPACEX", weight: 1 }], deployUsd: 5 });
    expect(res.status).toBe(200);
  });

  test("is refused past the 5% ceiling", async () => {
    // $5 would move the price 6%.
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { SPACEX: 100 }, impactPerUsd: { SPACEX: 0.012 } });
    const res = await build(a, { weights: [{ symbol: "SPACEX", weight: 1 }], deployUsd: 5 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Built & { problems: { kind: string; deferred?: { reason: string }[] }[] };
    expect(body.problems[0]?.kind).toBe("no-executable-legs");
    expect(body.problems[0]?.deferred?.[0]?.reason).toContain("more than the 5% we allow");
  });

  test("a larger order whose cost will not come down is refused past the ceiling too", async () => {
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { SPACEX: 100 }, priceImpact: { SPACEX: 0.08 } });
    const res = await build(a, { weights: [{ symbol: "SPACEX", weight: 1 }], deployUsd: 200 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Built & { problems: { deferred?: { reason: string }[] }[] };
    expect(body.problems[0]?.deferred?.[0]?.reason).toContain("at any size");
  });
});

describe("buying adds to a wallet and never rebalances it", () => {
  /*
   * A single-company buy adds to the wallet; it must not rebalance the wallet
   * toward 100% of that company, which would sell unrelated holdings to fund it.
   */
  const holder: FakeOptions = {
    usdcRaw: 1_000_000_000n,
    balances: { OPENAI: raw(20, 1.4861347) },
    priceUsd: { OPENAI: 100, POLYMARKET: 100 },
  };

  test("buys exactly the amount asked for and sells nothing", async () => {
    const res = await build(app(holder).app, { weights: [{ symbol: "POLYMARKET", weight: 1 }], deployUsd: 100 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Built;
    expect(body.mode).toBe("add");
    expect(body.legs.every((l) => l.side === "buy")).toBe(true);
    expect(body.legs.map((l) => l.symbol)).toEqual(["POLYMARKET"]);
    expect(body.legs[0]!.usd).toBeCloseTo(100, 6);
    expect(body.deferred.map((d) => d.symbol)).not.toContain("OPENAI");
  });

  test("names a single company after the company", async () => {
    const body = (await (
      await build(app(holder).app, { weights: [{ symbol: "POLYMARKET", weight: 1 }], deployUsd: 100 })
    ).json()) as Built;
    expect(body.target).toBe("Polymarket");
  });

  test("still rebalances when asked to by name", async () => {
    const res = await build(app(holder).app, {
      weights: [{ symbol: "POLYMARKET", weight: 1 }],
      deployUsd: 100,
      mode: "rebalance",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Built;
    expect((body.problems ?? []).map((p) => p.kind)).toContain("not-atomic");
  });
});

describe("the fee check counts the accounts a purchase opens", () => {
  /*
   * Each new token account needs a refundable deposit of about 0.002 SOL, so the
   * SOL requirement grows with the number of accounts a basket opens.
   */
  test("a new wallet buying several companies needs a deposit for each", async () => {
    const a = app({ usdcRaw: 1_000_000_000n, lamports: 5_000_000, priceUsd: { OPENAI: 100, ANTHROPIC: 100, POLYMARKET: 100 } });
    const res = await build(a.app, {
      weights: [
        { symbol: "OPENAI", weight: 1 },
        { symbol: "ANTHROPIC", weight: 1 },
        { symbol: "POLYMARKET", weight: 1 },
      ],
      deployUsd: 300,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { problems: { kind: string; requiredLamports?: number; newAccounts?: number }[] };
    const sol = body.problems.find((p) => p.kind === "insufficient-sol");
    expect(sol?.newAccounts).toBe(3);
    expect(sol?.requiredLamports).toBeGreaterThan(5_000_000);
  });

  test("an account that already exists needs no deposit", async () => {
    // Same SOL, but the wallet already holds all three, so nothing is opened.
    const a = app({
      usdcRaw: 1_000_000_000n,
      lamports: 5_000_000,
      balances: { OPENAI: raw(0.1, 1.4861347), ANTHROPIC: raw(0.1), POLYMARKET: raw(0.1) },
      priceUsd: { OPENAI: 100, ANTHROPIC: 100, POLYMARKET: 100 },
    });
    const res = await build(a.app, {
      weights: [
        { symbol: "OPENAI", weight: 1 },
        { symbol: "ANTHROPIC", weight: 1 },
        { symbol: "POLYMARKET", weight: 1 },
      ],
      deployUsd: 300,
    });
    expect(res.status).toBe(200);
  });
});

describe("the review can say what the user gets", () => {
  test("a buy leg carries the shares its quote promised", async () => {
    const a = app({ usdcRaw: 1_000_000_000n, priceUsd: { POLYMARKET: 100 } });
    const body = (await (
      await build(a.app, { weights: [{ symbol: "POLYMARKET", weight: 1 }], deployUsd: 100 })
    ).json()) as { legs: { symbol: string; expectedShares?: number }[] };
    expect(body.legs[0]!.expectedShares).toBeGreaterThan(0);
  });
});

describe("the transfer fee", () => {
  /*
   * On mainnet some routes deliver exactly 1% under the Jupiter quote and others
   * deliver the quote itself: whether a quote nets the Token-2022 fee depends
   * on the pool. The build allows for the fee on every leg, both in the
   * slippage tolerance and in what the review shows.
   *
   * The fake mints charge 0.5% in epoch 1038 and 1% from epoch 1039.
   */
  type Leg = { symbol: string; side: string; usd: number; slippageBps: number; feeAllowanceBps: number; expectedShares?: number; expectedUsd?: number };

  test("is added to every leg's tolerance, on top of the room for price movement", async () => {
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { ANTHROPIC: 100 } });
    const res = await build(a, { weights: [{ symbol: "ANTHROPIC", weight: 1 }], deployUsd: 100 });
    expect(res.status).toBe(200);
    const leg = ((await res.json()) as { legs: Leg[] }).legs[0]!;
    expect(leg.feeAllowanceBps).toBe(50);
    expect(leg.slippageBps).toBe(165 + 50);
  });

  test("allows for the scheduled fee in the last minutes of the epoch", async () => {
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { ANTHROPIC: 100 }, slotsLeftInEpoch: 500 });
    const res = await build(a, { weights: [{ symbol: "ANTHROPIC", weight: 1 }], deployUsd: 100 });
    expect(res.status).toBe(200);
    const leg = ((await res.json()) as { legs: Leg[] }).legs[0]!;
    expect(leg.feeAllowanceBps).toBe(100);
    expect(leg.slippageBps).toBe(165 + 100);
  });

  test("comes off the shares a buy promises", async () => {
    const { app: a } = app({ usdcRaw: 1_000_000_000n, priceUsd: { ANTHROPIC: 100 } });
    const res = await build(a, { weights: [{ symbol: "ANTHROPIC", weight: 1 }], deployUsd: 100 });
    const leg = ((await res.json()) as { legs: Leg[] }).legs[0]!;
    expect(leg.expectedShares).toBeCloseTo(0.999 * 0.995, 6);
  });

  test("comes off the dollars a sale promises", async () => {
    const holder = app({ balances: { ANTHROPIC: raw(2) }, priceUsd: { ANTHROPIC: 150 } });
    const res = await holder.app.request("/api/exit/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: WALLET, symbols: ["ANTHROPIC"] }),
    });
    expect(res.status).toBe(200);
    const leg = ((await res.json()) as { legs: Leg[] }).legs[0]!;
    expect(leg.side).toBe("sell");
    expect(leg.feeAllowanceBps).toBe(50);
    expect(leg.slippageBps).toBe(165 + 50);
    expect(leg.expectedUsd).toBeCloseTo(300 * 0.999 * 0.995, 4);
  });
});
