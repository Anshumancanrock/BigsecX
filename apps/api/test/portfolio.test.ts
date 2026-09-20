import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/index.ts";
import { makeServices, type FakeOptions } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
function app(options: FakeOptions = {}) {
  const services = makeServices(options);
  open.push(services.store);
  return { app: createApp(services), services };
}
afterEach(() => {
  while (open.length) open.pop()?.close();
});

const WALLET = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
/** 9 decimals. OPENAI carries a 1.4861347 scale multiplier. */
const raw = (uiAmount: number, multiplier = 1) =>
  BigInt(Math.round((uiAmount / multiplier) * 1e9));

describe("portfolio", () => {
  test("values holdings and reports weights", async () => {
    const { app: a } = app({
      balances: { OPENAI: raw(2, 1.4861347), ANTHROPIC: raw(1) },
      priceUsd: { OPENAI: 1_000, ANTHROPIC: 1_000 },
    });
    const body = (await (await a.request(`/api/portfolio/${WALLET}`)).json()) as {
      totalUsd: number;
      positions: { symbol: string; uiAmount: number; valueUsd: number; weight: number }[];
    };

    expect(body.totalUsd).toBeCloseTo(3_000, 0);
    const openai = body.positions.find((p) => p.symbol === "OPENAI");
    // The scale multiplier must be applied, or this reads 1.35 shares.
    expect(openai?.uiAmount).toBeCloseTo(2, 6);
    expect(openai?.weight).toBeCloseTo(2 / 3, 4);
  });

  test("omits zero balances rather than listing the whole universe", async () => {
    const { app: a } = app({ balances: { OPENAI: raw(1, 1.4861347) } });
    const body = (await (await a.request(`/api/portfolio/${WALLET}`)).json()) as {
      positions: unknown[];
    };
    expect(body.positions).toHaveLength(1);
  });

  test("reports cash and whether fees can be paid", async () => {
    const { app: a } = app({ usdcRaw: 250_000_000n, lamports: 1_000 });
    const body = (await (await a.request(`/api/portfolio/${WALLET}`)).json()) as {
      cash: { usdcUsd: number; solLamports: number; canPayFees: boolean };
    };
    expect(body.cash.usdcUsd).toBeCloseTo(250, 9);
    // A wallet with dust lamports cannot submit anything, whatever it holds.
    expect(body.cash.canPayFees).toBe(false);
  });

  test("flags a frozen account instead of counting it as sellable", async () => {
    const { app: a } = app({ balances: { OPENAI: raw(1, 1.4861347) }, frozen: ["OPENAI"] });
    const body = (await (await a.request(`/api/portfolio/${WALLET}`)).json()) as {
      frozen: string[];
      positions: { symbol: string; frozen: boolean }[];
    };
    expect(body.frozen).toEqual(["OPENAI"]);
    expect(body.positions[0]?.frozen).toBe(true);
  });

  test("names unpriced positions rather than valuing them at zero", async () => {
    const { app: a } = app({ balances: { OPENAI: raw(1, 1.4861347) }, pricesThrow: true });
    const body = (await (await a.request(`/api/portfolio/${WALLET}`)).json()) as {
      unpriced: string[];
      totalUsd: number;
      positions: { weight: number | null; valueUsd: number | null }[];
    };
    expect(body.unpriced).toEqual(["OPENAI"]);
    expect(body.totalUsd).toBe(0);
    // A weight against a total the position is not in would be a lie.
    expect(body.positions[0]?.weight).toBeNull();
    expect(body.positions[0]?.valueUsd).toBeNull();
  });

  test("an empty wallet is an empty portfolio, not an error", async () => {
    const { app: a } = app();
    const res = await a.request(`/api/portfolio/${WALLET}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { positions: unknown[]; totalUsd: number };
    expect(body.positions).toHaveLength(0);
    expect(body.totalUsd).toBe(0);
  });

  test("rejects a malformed wallet", async () => {
    expect((await app().app.request("/api/portfolio/notanaddress")).status).toBe(400);
  });
});

describe("portfolio compared to a strategy", () => {
  async function withStrategy(options: FakeOptions) {
    const { app: a } = app(options);
    const created = (await (
      await a.request("/api/strategies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creator: WALLET,
          name: "Even",
          weights: [
            { symbol: "OPENAI", weight: 50 },
            { symbol: "ANTHROPIC", weight: 50 },
          ],
          guardrails: { driftBps: 300 },
        }),
      })
    ).json()) as { id: string };
    return { a, id: created.id };
  }

  test("reports drift against the saved target", async () => {
    const { a, id } = await withStrategy({
      balances: { OPENAI: raw(7, 1.4861347), ANTHROPIC: raw(3) },
      priceUsd: { OPENAI: 100, ANTHROPIC: 100 },
    });
    const body = (await (await a.request(`/api/portfolio/${WALLET}?compare=${id}`)).json()) as {
      comparison: { exceeded: boolean; worst: { symbol: string; driftBps: number } };
    };
    // Held 70/30 against a 50/50 target: 2000bps of drift.
    expect(body.comparison.exceeded).toBe(true);
    expect(body.comparison.worst.driftBps).toBeCloseTo(2_000, 0);
  });

  test("404s on an unknown strategy rather than silently skipping it", async () => {
    const { a } = await withStrategy({ balances: { OPENAI: raw(1, 1.4861347) } });
    expect((await a.request(`/api/portfolio/${WALLET}?compare=ghost`)).status).toBe(404);
  });
});

describe("single-asset portfolio", () => {
  test("an unheld asset reports a zero position", async () => {
    const { app: a } = app({ priceUsd: { SPACEX: 120 } });
    const body = (await (await a.request(`/api/portfolio/${WALLET}/SPACEX`)).json()) as {
      position: { uiAmount: number; valueUsd: number; priceUsd: number };
    };
    expect(body.position.uiAmount).toBe(0);
    expect(body.position.valueUsd).toBe(0);
    expect(body.position.priceUsd).toBe(120);
  });

  test("unknown symbol is a 404", async () => {
    expect((await app().app.request(`/api/portfolio/${WALLET}/NVDA`)).status).toBe(404);
  });
});
