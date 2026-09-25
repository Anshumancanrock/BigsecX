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
  return { app: createApp(services), services };
}

describe("content type gate", () => {
  /*
   * A cross-origin POST with text/plain, form-urlencoded or multipart is a CORS
   * "simple request": no preflight, so the origin allow-list is never asked and
   * the side effect happens anyway. Requiring JSON forces the preflight.
   */
  const body = JSON.stringify({ indexId: "prediction", deployUsd: 100 });

  test("refuses the content types that skip a preflight", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      const res = await app().app.request("/api/mirror/plan", {
        method: "POST",
        headers: type ? { "content-type": type } : {},
        body,
      });
      expect(res.status).toBe(415);
    }
  });

  test("accepts JSON, including with a charset", async () => {
    for (const type of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"]) {
      const res = await app().app.request("/api/mirror/plan", {
        method: "POST",
        headers: { "content-type": type },
        body,
      });
      expect(res.status).not.toBe(415);
    }
  });

  test("leaves reads alone: a GET cannot carry a body anyway", async () => {
    expect((await app().app.request("/api/market")).status).toBe(200);
    expect((await app().app.request("/api/indexes")).status).toBe(200);
  });
});

describe("response headers", () => {
  test("API responses refuse to be sniffed, cached or to leak a referrer", async () => {
    const res = await app().app.request("/api/indexes");
    // A JSON body a browser decides to sniff as HTML is an XSS primitive,
    // and these bodies echo caller-supplied strings such as a basket name.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("they are set on errors too, not just on the happy path", async () => {
    const res = await app().app.request("/api/indexes/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("amount coercion", () => {
  const plan = (deployUsd: unknown) =>
    app().app.request("/api/mirror/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ indexId: "prediction", deployUsd }),
    });

  test("a boolean is not an amount, however willing Number() is to coerce it", async () => {
    // Number(true) is 1, so a bare coercion turns a client bug into a real
    // trade for one dollar.
    expect((await plan(true)).status).toBe(400);
    expect((await plan(false)).status).toBe(400);
  });

  test("neither is an array, an object, or a string with letters in it", async () => {
    for (const bad of [[], {}, "100abc", "Infinity", "1e400", -1]) {
      expect((await plan(bad)).status).toBe(400);
    }
  });

  test("a numeric string still works, since form inputs produce them", async () => {
    expect((await plan("100")).status).toBe(200);
    expect((await plan(" 100 ")).status).toBe(200);
  });
});

describe("concurrent authorship", () => {
  test("two baskets published at once under the same name get distinct ids", async () => {
    const { app: a } = app();
    const wallet = new TestWallet();
    const make = async (n: number) => {
      const payload = {
        creator: wallet.address,
        name: "Same Name",
        description: `run ${n}`,
        weights: [{ symbol: "OPENAI", weight: 1 }, { symbol: "KALSHI", weight: 1 }],
        rebalance: "manual",
        published: true,
      };
      const signed = await wallet.sign("create-strategy", "new", payload);
      return a.request("/api/strategies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, ...signed }),
      });
    };

    const results = await Promise.all([make(1), make(2), make(3)]);
    const ids = await Promise.all(results.map(async (r) => ((await r.json()) as { id: string }).id));
    expect(results.every((r) => r.status === 201)).toBe(true);
    // The random suffix on the slug is what keeps these apart; without it
    // the third write would silently overwrite the first.
    expect(new Set(ids).size).toBe(3);
  });
});
