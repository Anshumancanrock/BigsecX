import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { makeServices, TestWallet } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

function app() {
  const services = makeServices();
  open.push(services.store);
  return createApp(services);
}

const post = (a: ReturnType<typeof createApp>, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/*
 * `Number()` accepts true, [], "" and null. These cases cover every request
 * field that becomes a number, so the rule holds for all of them.
 */
const NOT_NUMBERS = [true, false, [], {}, null, "", "  ", "abc", "1abc", "Infinity", "NaN"];

describe("every numeric request field refuses a non-number", () => {
  test("deployUsd on a mirror plan", async () => {
    for (const bad of NOT_NUMBERS) {
      const res = await post(app(), "/api/mirror/plan", { indexId: "prediction", deployUsd: bad });
      expect(res.status, `deployUsd=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  test("a weight inside a basket", async () => {
    const wallet = new TestWallet();
    for (const bad of NOT_NUMBERS) {
      const payload = {
        creator: wallet.address,
        name: "Coercion",
        weights: [{ symbol: "OPENAI", weight: bad }, { symbol: "KALSHI", weight: 1 }],
        rebalance: "manual",
      };
      const res = await post(app(), "/api/strategies", { ...payload, ...(await wallet.sign("create-strategy", "new", payload)) });
      expect(res.status, `weight=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  test("a guardrail fraction", async () => {
    const wallet = new TestWallet();
    for (const bad of [true, [], {}, "abc"]) {
      const payload = {
        creator: wallet.address,
        name: "Guardrail",
        weights: [{ symbol: "OPENAI", weight: 1 }, { symbol: "KALSHI", weight: 1 }],
        rebalance: "manual",
        guardrails: { maxWeight: bad },
      };
      const res = await post(app(), "/api/strategies", { ...payload, ...(await wallet.sign("create-strategy", "new", payload)) });
      expect(res.status, `maxWeight=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  test("usd inside an overlap request", async () => {
    for (const bad of [true, [], {}, "abc", null]) {
      const res = await post(app(), "/api/strategies/overlap", { holdings: [{ strategyId: "x", usd: bad }] });
      expect(res.status, `usd=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  test("capital and limits on a copy preview", async () => {
    for (const bad of [true, [], {}, "abc"]) {
      const res = await post(app(), "/api/copy/preview", {
        leader: "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
        capitalUsd: bad,
      });
      expect(res.status, `capitalUsd=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  test("the stop-loss fraction", async () => {
    for (const bad of [true, [], {}, "abc"]) {
      const res = await post(app(), "/api/copy/stop-check", {
        peakValueUsd: 1000,
        currentValueUsd: 900,
        stopLossFraction: bad,
      });
      expect(res.status, `stopLossFraction=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  test("a query integer", async () => {
    for (const bad of ["abc", "true", "[]"]) {
      const res = await app().request(`/api/leaderboard?limit=${encodeURIComponent(bad)}`);
      expect(res.status, `limit=${bad}`).toBe(400);
    }
  });

  test("real numbers and numeric strings still work", async () => {
    // The guard must not over-reject: form inputs produce strings.
    expect((await post(app(), "/api/mirror/plan", { indexId: "prediction", deployUsd: 100 })).status).toBe(200);
    expect((await post(app(), "/api/mirror/plan", { indexId: "prediction", deployUsd: "100" })).status).toBe(200);
    expect((await post(app(), "/api/mirror/plan", { indexId: "prediction", deployUsd: " 100.5 " })).status).toBe(200);
    expect((await app().request("/api/leaderboard?limit=10")).status).toBe(200);
  });
});
