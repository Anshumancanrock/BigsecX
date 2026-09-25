import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { makeServices } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
function app(priceUsd: Record<string, number> = { OPENAI: 100, SPACEX: 100 }) {
  const services = makeServices({ priceUsd });
  open.push(services.store);
  return { app: createApp(services), store: services.store };
}
afterEach(() => {
  while (open.length) open.pop()?.close();
});

const W = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
let seq = 0;
const trade = (symbol: string, uiAmount: number, valueUsd: number | null, slot: number) => ({
  signature: `sig${seq++}`,
  owner: W,
  symbol,
  slot,
  blockTime: 1_789_000_000 + slot,
  deltaRaw: 1n,
  uiAmount,
  valueUsd,
});

describe("trader profile", () => {
  test("marks an open position against its observed cost", async () => {
    const { app: a, store } = app({ OPENAI: 120 });
    // Bought 10 shares for $1,000; they now mark at $1,200.
    store.writeTrades([trade("OPENAI", 10, 1_000, 10)]);

    const body = (await (await a.request(`/api/traders/${W}`)).json()) as {
      pnlUsd: number;
      returnFraction: number;
      coverageComplete: boolean;
      weights: { symbol: string; weight: number }[];
      sectors: Record<string, number>;
    };
    expect(body.pnlUsd).toBeCloseTo(200, 6);
    expect(body.returnFraction).toBeCloseTo(0.2, 6);
    expect(body.coverageComplete).toBe(true);
    expect(body.weights).toEqual([{ symbol: "OPENAI", weight: 1 }]);
    expect(body.sectors["ai-lab"]).toBeCloseTo(1, 9);
  });

  test("books a closed round trip and counts it as a win", async () => {
    const { app: a, store } = app();
    store.writeTrades([trade("OPENAI", 10, 1_000, 10), trade("OPENAI", -10, -1_300, 20)]);

    const body = (await (await a.request(`/api/traders/${W}`)).json()) as {
      pnlUsd: number;
      closedTrades: number;
      winRate: number;
      positions: unknown[];
    };
    expect(body.pnlUsd).toBeCloseTo(300, 6);
    expect(body.closedTrades).toBe(1);
    expect(body.winRate).toBe(1);
    expect(body.positions).toHaveLength(0);
  });

  test("counts a losing round trip as a loss, not a win", async () => {
    // Counting sells instead of round trips would call this a win.
    const { app: a, store } = app();
    store.writeTrades([trade("SPACEX", 10, 1_000, 10), trade("SPACEX", -10, -700, 20)]);

    const body = (await (await a.request(`/api/traders/${W}`)).json()) as {
      pnlUsd: number;
      winRate: number;
      closedTrades: number;
    };
    expect(body.pnlUsd).toBeCloseTo(-300, 6);
    expect(body.closedTrades).toBe(1);
    expect(body.winRate).toBe(0);
  });

  test("return is measured against peak capital, not the closing balance", async () => {
    const { app: a, store } = app();
    store.writeTrades([trade("OPENAI", 10, 1_500, 10), trade("OPENAI", -10, -1_100, 20)]);
    const body = (await (await a.request(`/api/traders/${W}`)).json()) as {
      peakInvestedUsd: number;
      returnFraction: number;
    };
    expect(body.peakInvestedUsd).toBeCloseTo(1_500, 6);
    // Dividing by the closing net invested would report -100%.
    expect(body.returnFraction).toBeCloseTo(-400 / 1_500, 6);
  });

  test("flags a record whose cost basis is incomplete", async () => {
    const { app: a, store } = app();
    // A SOL-routed swap with no price.
    store.writeTrades([trade("OPENAI", 5, null, 10)]);
    const body = (await (await a.request(`/api/traders/${W}`)).json()) as {
      coverageComplete: boolean;
      caveats: string[];
    };
    expect(body.coverageComplete).toBe(false);
    expect(body.caveats.join(" ")).toContain("rough");
  });

  test("a wallet with no indexed trades is empty, not an error", async () => {
    const { app: a } = app();
    const res = await a.request(`/api/traders/${W}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trades: number; winRate: number | null };
    expect(body.trades).toBe(0);
    expect(body.winRate).toBeNull();
  });

  test("the window excludes older activity", async () => {
    const { app: a, store } = app();
    // One recent trade and one roughly 100 hours older.
    store.writeTrades([trade("OPENAI", 1, 100, 1_000_000), trade("OPENAI", 1, 100, 100_000)]);
    const narrow = (await (await a.request(`/api/traders/${W}?hours=1`)).json()) as { trades: number };
    const wide = (await (await a.request(`/api/traders/${W}?hours=1000`)).json()) as { trades: number };
    expect(narrow.trades).toBe(1);
    expect(wide.trades).toBe(2);
  });

  test("rejects a malformed wallet", async () => {
    expect((await app().app.request("/api/traders/nope")).status).toBe(400);
  });
});

describe("trade history", () => {
  test("labels sides and reports absolute sizes", async () => {
    const { app: a, store } = app();
    store.writeTrades([trade("OPENAI", 10, 1_000, 10), trade("OPENAI", -4, -500, 20)]);

    const body = (await (await a.request(`/api/traders/${W}/trades`)).json()) as {
      trades: { side: string; uiAmount: number; valueUsd: number; at: string }[];
    };
    expect(body.trades).toHaveLength(2);
    // Newest first.
    expect(body.trades[0]?.side).toBe("sell");
    expect(body.trades[0]?.uiAmount).toBe(4);
    expect(body.trades[0]?.valueUsd).toBe(500);
    expect(body.trades[0]?.at).toBeTruthy();
  });

  test("honours the limit", async () => {
    const { app: a, store } = app();
    store.writeTrades(Array.from({ length: 20 }, (_, i) => trade("OPENAI", 1, 10, i + 1)));
    const body = (await (await a.request(`/api/traders/${W}/trades?limit=5`)).json()) as {
      trades: unknown[];
    };
    expect(body.trades).toHaveLength(5);
  });
});
