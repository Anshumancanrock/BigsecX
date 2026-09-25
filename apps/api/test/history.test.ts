import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { PriceHistory, dayOf, geckoTerminal, mergeDaily, type HistorySource } from "../src/lib/price-history.ts";
import { historyTable } from "../src/routes/history.ts";
import { makeServices } from "./fakes.ts";
import type { Store } from "@ps/db";

const DAY = 86_400;
const T0 = Date.UTC(2026, 8, 1) / 1000; // 2026-09-01

const candle = (dayIndex: number, close: number, volumeUsd = 100) => ({ time: T0 + dayIndex * DAY, close, volumeUsd });

describe("mergeDaily", () => {
  test("takes each day's close from the pool that traded most that day", () => {
    const busy = [candle(0, 10, 900), candle(1, 11, 50)];
    const quiet = [candle(0, 99, 10), candle(1, 12, 500)];
    const merged = mergeDaily([busy, quiet]);
    expect(merged.get("2026-09-01")).toBe(10);
    expect(merged.get("2026-09-02")).toBe(12);
  });

  test("drops a close far from the week around it", () => {
    // A new pool's first print can be far off: this one opened at a fifth of
    // the price it traded at for the rest of the week.
    const closes = [100, 101, 99, 20, 102, 100, 98].map((c, i) => candle(i, c));
    const merged = mergeDaily([closes]);
    expect(merged.has("2026-09-04")).toBe(false);
    expect(merged.size).toBe(6);
  });

  test("keeps a real move that its neighbours share", () => {
    const closes = [100, 100, 100, 160, 165, 170, 168].map((c, i) => candle(i, c));
    expect(mergeDaily([closes]).size).toBe(7);
  });
});

describe("historyTable", () => {
  const snapshot = {
    unixSeconds: T0 + 2 * DAY + 3_600,
    takenAt: new Date((T0 + 2 * DAY + 3_600) * 1000),
    tokens: [
      { token: { symbol: "SPACEX" }, multiplier: 5, marketUsd: 112 },
      { token: { symbol: "OPENAI" }, multiplier: 1, marketUsd: 1_200 },
    ],
  } as never;

  test("divides raw closes by the current multiplier and ends on the live price", () => {
    const table = historyTable(
      { SPACEX: { "2026-09-01": 550, "2026-09-02": 560 } },
      snapshot,
      365,
    );
    expect(table.days).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(table.prices["SPACEX"]).toEqual([110, 112, 112]);
    // A company with no candles still gets a row, null until today.
    expect(table.prices["OPENAI"]).toEqual([null, null, 1_200]);
  });

  test("an empty cache is an empty table, not a one-point chart", () => {
    expect(historyTable({}, snapshot, 365)).toEqual({ days: [], prices: {} });
  });
});

describe("PriceHistory", () => {
  const source = (overrides: Partial<HistorySource> = {}): HistorySource => ({
    pools: async () => [{ address: "pool", side: "base", reserveUsd: 1_000 }],
    daily: async () => [candle(0, 10), candle(1, 11)],
    ...overrides,
  });

  test("a refresh fills every company and writes the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "history-"));
    const path = join(dir, "price-history.json");
    const history = new PriceHistory(source(), path);
    await history.refresh();
    expect(Object.keys(history.closes()).length).toBe(8);
    const written = JSON.parse(readFileSync(path, "utf8")) as { bySymbol: Record<string, unknown> };
    expect(Object.keys(written.bySymbol).length).toBe(8);
    // A new instance serves the cache immediately, with no fetch at all.
    const restarted = new PriceHistory(
      source({
        pools: async () => {
          throw new Error("must not be called");
        },
      }),
      path,
    );
    expect(restarted.fetchedAt).not.toBeNull();
    expect(restarted.closes()["SPACEX"]?.["2026-09-02"]).toBe(11);
  });

  test("one company failing keeps the others", async () => {
    let calls = 0;
    const history = new PriceHistory(
      source({
        pools: async () => {
          calls++;
          if (calls === 1) throw new Error("HTTP 500");
          return [{ address: "pool", side: "base", reserveUsd: 1 }];
        },
      }),
    );
    await history.refresh();
    expect(Object.keys(history.closes()).length).toBe(7);
    expect(history.lastError).toContain("HTTP 500");
  });

  test("concurrent refreshes share one run", async () => {
    let pools = 0;
    const history = new PriceHistory(
      source({
        pools: async () => {
          pools++;
          return [{ address: "pool", side: "base", reserveUsd: 1 }];
        },
      }),
    );
    await Promise.all([history.refresh(), history.refresh(), history.refresh()]);
    expect(pools).toBe(8);
  });
});

describe("geckoTerminal", () => {
  test("reads which side of the pool the token is on, busiest first", async () => {
    const mint = "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh";
    const fetchImpl = (async () =>
      Response.json({
        data: [
          {
            // Deep but idle: a side pair holding a lot and trading nothing.
            attributes: { address: "deep", reserve_in_usd: "118000", volume_usd: { h24: "36" } },
            relationships: { base_token: { data: { id: "solana_other" } } },
          },
          {
            attributes: { address: "busy", reserve_in_usd: "10000", volume_usd: { h24: "5388" } },
            relationships: { base_token: { data: { id: `solana_${mint}` } } },
          },
        ],
      })) as unknown as typeof fetch;
    const pools = await geckoTerminal({ fetchImpl, minIntervalMs: 0 }).pools(mint);
    expect(pools.map((p) => p.address)).toEqual(["busy", "deep"]);
    expect(pools[0]!.side).toBe("base");
    expect(pools[1]!.side).toBe("quote");
  });

  test("parses candles and skips malformed rows", async () => {
    const fetchImpl = (async () =>
      Response.json({
        data: { attributes: { ohlcv_list: [[T0, 1, 2, 0.5, 1.5, 300], [T0 + DAY, 1, 2, 0.5], [T0 + 2 * DAY, 1, 1, 1, "x", 1]] } },
      })) as unknown as typeof fetch;
    const candles = await geckoTerminal({ fetchImpl, minIntervalMs: 0 }).daily(
      { address: "p", side: "base", reserveUsd: 1 },
      30,
    );
    expect(candles).toEqual([{ time: T0, close: 1.5, volumeUsd: 300 }]);
  });
});

const open: Store[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

describe("GET /api/history", () => {
  test("says it is not complete when nothing has been fetched", async () => {
    const services = makeServices();
    open.push(services.store);
    const res = await createApp(services).request("/api/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { complete: boolean; days: string[] };
    expect(body.complete).toBe(false);
    expect(body.days).toEqual([]);
  });

  test("serves the cached history, aligned by day", async () => {
    const history = new PriceHistory({
      pools: async () => [{ address: "pool", side: "base", reserveUsd: 1 }],
      daily: async () => {
        const now = Math.floor(Date.now() / 1000);
        return [
          { time: now - 2 * DAY, close: 100, volumeUsd: 1 },
          { time: now - DAY, close: 110, volumeUsd: 1 },
        ];
      },
    });
    await history.refresh();
    const services = { ...makeServices(), history };
    open.push(services.store);
    const res = await createApp(services).request("/api/history?days=30");
    const body = (await res.json()) as { complete: boolean; days: string[]; prices: Record<string, (number | null)[]> };
    expect(body.complete).toBe(true);
    expect(body.days.length).toBeGreaterThanOrEqual(3);
    expect(body.prices["ANTHROPIC"]!.length).toBe(body.days.length);
    expect(body.days.at(-1)).toBe(dayOf(Math.floor(Date.now() / 1000)));
  });

  test("clamps an out-of-range window, as every route here does, and rejects a non-number", async () => {
    const services = makeServices();
    open.push(services.store);
    const a = createApp(services);
    expect((await a.request("/api/history?days=0")).status).toBe(200);
    expect((await a.request("/api/history?days=soon")).status).toBe(400);
  });
});

describe("GET /api/trades/recent", () => {
  test("lists believable trades newest first and drops the rest", async () => {
    const services = makeServices({ priceUsd: { OPENAI: 1_000, SPACEX: 100 } });
    open.push(services.store);
    services.store.writeTrades([
      { signature: "a", owner: "w1", symbol: "OPENAI", slot: 10, blockTime: 1, deltaRaw: 1n, uiAmount: 0.1, valueUsd: 101 },
      // Paid $92 to receive half a dollar of OpenAI: another leg's money.
      { signature: "b", owner: "w2", symbol: "OPENAI", slot: 20, blockTime: 2, deltaRaw: 1n, uiAmount: 0.0004, valueUsd: -92 },
      { signature: "c", owner: "w3", symbol: "SPACEX", slot: 30, blockTime: 3, deltaRaw: -1n, uiAmount: -2, valueUsd: -190 },
    ]);
    const res = await createApp(services).request("/api/trades/recent?limit=5");
    const body = (await res.json()) as { trades: { signature: string; side: string; valueUsd: number }[] };
    expect(body.trades.map((t) => t.signature)).toEqual(["c", "a"]);
    expect(body.trades[0]).toMatchObject({ side: "sell", valueUsd: 190 });
  });
});
