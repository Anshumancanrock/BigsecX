import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/index.ts";
import { makeServices, type FakeOptions } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
function app(options: FakeOptions = {}) {
  const services = makeServices(options);
  open.push(services.store);
  return createApp(services);
}
afterEach(() => {
  while (open.length) open.pop()?.close();
});

describe("asset list", () => {
  test("reports activity alongside price", async () => {
    // Without volume and holders, a market page shows price and says nothing
    // about whether anyone is trading or holding.
    const body = (await (await app().request("/api/assets")).json()) as {
      activityAvailable: boolean;
      assets: { symbol: string; volumeUsd: number; holders: number; holderGrowth7d: number }[];
    };

    expect(body.activityAvailable).toBe(true);
    expect(body.assets).toHaveLength(8);
    const openai = body.assets.find((a) => a.symbol === "OPENAI");
    // Cumulative series rising by 100 a day; the newest row is the day in
    // progress, so the latest complete day is the one before it.
    expect(openai?.volumeUsd).toBe(100);
    expect(openai?.holders).toBe(100);
    expect(openai?.holderGrowth7d).toBeCloseTo(1, 9);
  });

  test("says when activity data is unavailable rather than showing zero", async () => {
    // An empty column must read as an upstream failure, not as no trading.
    const body = (await (await app({ statsThrow: true }).request("/api/assets")).json()) as {
      activityAvailable: boolean;
      assets: { volumeUsd: number | null; holders: number | null }[];
    };
    expect(body.activityAvailable).toBe(false);
    expect(body.assets[0]?.volumeUsd).toBeNull();
    expect(body.assets[0]?.holders).toBeNull();
  });

  test("prices still work when the issuer is down", async () => {
    const body = (await (await app({ statsThrow: true, priceUsd: { OPENAI: 1_000 } }).request("/api/assets")).json()) as {
      assets: { symbol: string; marketUsd: number }[];
    };
    expect(body.assets.find((a) => a.symbol === "OPENAI")?.marketUsd).toBe(1_000);
  });
});

describe("asset detail", () => {
  test("returns the history a chart needs", async () => {
    const body = (await (await app().request("/api/assets/OPENAI")).json()) as {
      symbol: string;
      launchedAt: string;
      volume: { date: string; usd: number }[];
      holders: { week: string; holders: number }[];
      issuerControl: { permanentDelegate: string | null };
    };

    expect(body.symbol).toBe("OPENAI");
    expect(body.launchedAt).toContain("2025-08-07");
    // Daily figures, differenced from the cumulative series.
    expect(body.volume.every((v) => v.usd === 100)).toBe(true);
    expect(body.holders.map((h) => h.holders)).toEqual([50, 100]);
    // Issuer powers travel with the asset.
    expect(body.issuerControl).toBeDefined();
  });

  test("accepts a lowercase symbol", async () => {
    expect((await app().request("/api/assets/openai")).status).toBe(200);
  });

  test("an unknown symbol lists what is known", async () => {
    const res = await app().request("/api/assets/NVDA");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { known: string[] };
    expect(body.known).toContain("OPENAI");
  });

  test("clamps a hostile range instead of failing", async () => {
    expect((await app().request("/api/assets/OPENAI?days=99999&weeks=-5")).status).toBe(200);
  });

  test("detail survives the issuer being down", async () => {
    const body = (await (await app({ statsThrow: true }).request("/api/assets/OPENAI")).json()) as {
      activityAvailable: boolean;
      volume: unknown[];
      price: { marketUsd: number };
    };
    expect(body.activityAvailable).toBe(false);
    expect(body.volume).toEqual([]);
    expect(body.price.marketUsd).toBeGreaterThan(0);
  });
});
