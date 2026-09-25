import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { throttle } from "../src/lib/throttle.ts";

// Forwarded headers are honoured only behind a declared proxy, so these
// tests declare one. Without it every caller keys to the socket address,
// which is what the no-proxy case is for.
const previousTrustProxy = process.env["TRUST_PROXY"];
beforeAll(() => {
  process.env["TRUST_PROXY"] = "1";
});
afterAll(() => {
  if (previousTrustProxy === undefined) delete process.env["TRUST_PROXY"];
  else process.env["TRUST_PROXY"] = previousTrustProxy;
});

function app(options = {}) {
  const a = new Hono();
  a.use("/*", throttle(options));
  a.get("/health", (c) => c.json({ ok: true }));
  a.get("/api/market", (c) => c.json({ ok: true }));
  a.post("/api/mirror/build", (c) => c.json({ ok: true }));
  return a;
}

const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

describe("throttle", () => {
  test("never throttles health, so a probe cannot be locked out", async () => {
    const a = app({ capacity: 1, refillPerSecond: 0.0001 });
    for (let i = 0; i < 50; i++) {
      expect((await a.request("/health", from("1.1.1.1"))).status).toBe(200);
    }
  });

  test("charges a build far more than a cached read", async () => {
    // One build costs forty units; the same budget allows many market reads.
    const a = app({ capacity: 40, refillPerSecond: 0.0001 });
    expect((await a.request("/api/mirror/build", { method: "POST", ...from("2.2.2.2") })).status).toBe(200);
    expect((await a.request("/api/mirror/build", { method: "POST", ...from("2.2.2.2") })).status).toBe(429);

    const b = app({ capacity: 40, refillPerSecond: 0.0001 });
    for (let i = 0; i < 40; i++) {
      expect((await b.request("/api/market", from("3.3.3.3"))).status).toBe(200);
    }
    expect((await b.request("/api/market", from("3.3.3.3"))).status).toBe(429);
  });

  test("tells the caller how long to wait", async () => {
    const a = app({ capacity: 1, refillPerSecond: 1 });
    await a.request("/api/market", from("4.4.4.4"));
    const res = await a.request("/api/mirror/build", { method: "POST", ...from("4.4.4.4") });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(((await res.json()) as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  test("budgets are per client, not global", async () => {
    // One impatient client must not lock everyone else out.
    const a = app({ capacity: 40, refillPerSecond: 0.0001 });
    expect((await a.request("/api/mirror/build", { method: "POST", ...from("5.5.5.5") })).status).toBe(200);
    expect((await a.request("/api/mirror/build", { method: "POST", ...from("5.5.5.5") })).status).toBe(429);
    expect((await a.request("/api/mirror/build", { method: "POST", ...from("6.6.6.6") })).status).toBe(200);
  });

  test("refills over time", async () => {
    const a = app({ capacity: 2, refillPerSecond: 100 });
    await a.request("/api/market", from("7.7.7.7"));
    await a.request("/api/market", from("7.7.7.7"));
    expect((await a.request("/api/market", from("7.7.7.7"))).status).toBe(429);
    await new Promise((r) => setTimeout(r, 60));
    expect((await a.request("/api/market", from("7.7.7.7"))).status).toBe(200);
  });

  test("ignores a forwarded header when no proxy is declared", async () => {
    // Otherwise any caller picks its own bucket by inventing a header.
    const saved = process.env["TRUST_PROXY"];
    delete process.env["TRUST_PROXY"];
    try {
      const a = app({ capacity: 40, refillPerSecond: 0.0001 });
      expect((await a.request("/api/mirror/build", { method: "POST", ...from("8.8.8.8") })).status).toBe(200);
      // A different claimed address must not reset the budget.
      expect((await a.request("/api/mirror/build", { method: "POST", ...from("9.9.9.9") })).status).toBe(429);
    } finally {
      if (saved !== undefined) process.env["TRUST_PROXY"] = saved;
    }
  });

  test("never lets a request through unmetered when the map is full", async () => {
    // Failing open under pressure hands an attacker the bypass: fill the map
    // with distinct addresses and everything after is free.
    const a = app({ capacity: 40, refillPerSecond: 0.0001, maxClients: 4 });
    for (let i = 0; i < 20; i++) {
      await a.request("/api/market", from(`172.16.0.${i}`));
    }
    // A fresh client still gets its own budget, and still runs out.
    expect((await a.request("/api/mirror/build", { method: "POST", ...from("172.31.0.1") })).status).toBe(200);
    expect((await a.request("/api/mirror/build", { method: "POST", ...from("172.31.0.1") })).status).toBe(429);
  });

  test("does not retain a client entry per address forever", async () => {
    // The limiter must not become the memory leak it exists to prevent.
    const a = app({ capacity: 1_000, refillPerSecond: 1_000, maxClients: 10 });
    for (let i = 0; i < 200; i++) {
      expect((await a.request("/api/market", from(`10.0.0.${i}`))).status).toBe(200);
    }
  });
});
