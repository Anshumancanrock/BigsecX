import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/index.ts";
import { makeServices } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
function app() {
  const services = makeServices();
  open.push(services.store);
  return createApp(services);
}
afterEach(() => {
  while (open.length) open.pop()?.close();
});

const ALICE = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const BOB = "4acSCrTSNXQPHVENCJNXaVmBhuFPNrDRYCqLLNqJvuQY";

const send = (a: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  a.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const draft = (over: Record<string, unknown> = {}) => ({
  creator: ALICE,
  name: "Humanoid Revolution",
  description: "robots that act on the world",
  weights: [
    { symbol: "FIGUREAI", weight: 60 },
    { symbol: "NEURALINK", weight: 40 },
  ],
  ...over,
});

describe("creating strategies", () => {
  test("stores exactly the allocation the author asked for", async () => {
    const res = await send(app(), "POST", "/api/strategies", draft());
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      creator: string;
      published: boolean;
      weights: { symbol: string; weight: number }[];
    };
    expect(body.kind).toBe("user");
    expect(body.creator).toBe(ALICE);
    expect(body.published).toBe(false);
    expect(body.weights.find((w) => w.symbol === "FIGUREAI")?.weight).toBeCloseTo(0.6, 9);
    // The id is readable, so a shared link says what it points at.
    expect(body.id.startsWith("humanoid-revolution-")).toBe(true);
  });

  test("reports sector exposure alongside the weights", async () => {
    const res = await send(
      app(),
      "POST",
      "/api/strategies",
      draft({
        name: "Defense",
        weights: [
          { symbol: "SPACEX", weight: 50 },
          { symbol: "ANDURIL", weight: 50 },
        ],
      }),
    );
    const body = (await res.json()) as { sectors: Record<string, number> };
    // Both are defence; SpaceX is also space.
    expect(body.sectors["defense"]).toBeCloseTo(1, 9);
    expect(body.sectors["space"]).toBeCloseTo(0.5, 9);
  });

  test("returns every validation problem at once", async () => {
    const res = await send(
      app(),
      "POST",
      "/api/strategies",
      draft({
        name: "",
        weights: [
          { symbol: "OPENAI", weight: 1 },
          { symbol: "ANTHROPIC", weight: 1 },
          { symbol: "SPACEX", weight: 1 },
        ],
        guardrails: { maxWeight: 0.25 },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { problems: string[] };
    expect(body.problems.length).toBeGreaterThan(1);
    expect(body.problems.join(" ")).toContain("cannot sum to 100%");
  });

  test("rejects an unknown symbol before the domain sees it", async () => {
    const res = await send(app(), "POST", "/api/strategies", draft({ weights: [{ symbol: "NVDA", weight: 1 }, { symbol: "OPENAI", weight: 1 }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown symbol");
  });

  test("requires a valid creator address", async () => {
    const res = await send(app(), "POST", "/api/strategies", draft({ creator: "nope" }));
    expect(res.status).toBe(400);
  });

  test("rejects an unknown rebalance frequency", async () => {
    const res = await send(app(), "POST", "/api/strategies", draft({ rebalance: "hourly" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("rebalance must be");
  });

  test("rejects a guardrail outside 0..1", async () => {
    const res = await send(app(), "POST", "/api/strategies", draft({ guardrails: { maxWeight: 40 } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("fraction");
  });
});

describe("visibility and ownership", () => {
  test("a draft is private to its author", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", draft())).json()) as { id: string };

    const publicList = (await (await a.request("/api/strategies")).json()) as { strategies: unknown[] };
    expect(publicList.strategies).toHaveLength(0);

    const mine = (await (await a.request(`/api/strategies?creator=${ALICE}`)).json()) as {
      strategies: { id: string }[];
    };
    expect(mine.strategies.map((s) => s.id)).toEqual([created.id]);
  });

  test("publishing makes it visible to everyone", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", draft({ published: true }))).json()) as {
      id: string;
    };
    const list = (await (await a.request("/api/strategies")).json()) as { strategies: { id: string }[] };
    expect(list.strategies.map((s) => s.id)).toEqual([created.id]);
  });

  test("another wallet cannot edit it", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", draft())).json()) as { id: string };
    const res = await send(a, "PUT", `/api/strategies/${created.id}`, {
      creator: BOB,
      name: "Stolen",
      weights: [
        { symbol: "OPENAI", weight: 1 },
        { symbol: "ANTHROPIC", weight: 1 },
      ],
    });
    expect(res.status).toBe(403);
  });

  test("another wallet cannot delete it", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", draft())).json()) as { id: string };
    expect((await send(a, "DELETE", `/api/strategies/${created.id}`, { creator: BOB })).status).toBe(403);
    expect((await send(a, "DELETE", `/api/strategies/${created.id}`, { creator: ALICE })).status).toBe(200);
    expect((await a.request(`/api/strategies/${created.id}`)).status).toBe(404);
  });

  test("an unknown id is a 404 on every route", async () => {
    const a = app();
    expect((await a.request("/api/strategies/nope")).status).toBe(404);
    expect((await send(a, "PUT", "/api/strategies/nope", draft())).status).toBe(404);
    expect((await send(a, "DELETE", "/api/strategies/nope", { creator: ALICE })).status).toBe(404);
  });
});

describe("response consistency", () => {
  test("the create response equals a subsequent read", async () => {
    // Timestamps persist to the second, so echoing the in-memory value gave
    // the caller a createdAt that changed on the next fetch.
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", draft())).json()) as {
      id: string;
    };
    const fetched = await (await a.request(`/api/strategies/${created.id}`)).json();
    expect(fetched).toEqual(created);
  });
});

describe("editing", () => {
  test("an edit keeps the original creation time and the stored guardrails", async () => {
    const a = app();
    const created = (await (
      await send(a, "POST", "/api/strategies", draft({ guardrails: { maxWeight: 0.7, driftBps: 111 } }))
    ).json()) as { id: string; createdAt: string };

    const updated = (await (
      await send(a, "PUT", `/api/strategies/${created.id}`, { creator: ALICE, name: "Renamed" })
    ).json()) as {
      name: string;
      createdAt: string;
      guardrails: { maxWeight: number; driftBps: number };
      weights: { symbol: string; weight: number }[];
    };

    expect(updated.name).toBe("Renamed");
    // The create response must already equal what a later read returns, or a
    // client that caches it sees the timestamp change under it.
    expect(updated.createdAt).toBe(created.createdAt);
    // Omitted guardrails must not be dropped by a rename.
    expect(updated.guardrails.driftBps).toBe(111);
    expect(updated.guardrails.maxWeight).toBeCloseTo(0.7, 9);
    // Nor may the weights vanish.
    expect(updated.weights).toHaveLength(2);
  });
});

describe("overlap", () => {
  test("reveals concentration hidden across baskets", async () => {
    const a = app();
    const one = (await (
      await send(
        a,
        "POST",
        "/api/strategies",
        draft({
          name: "AI",
          published: true,
          weights: [
            { symbol: "OPENAI", weight: 60 },
            { symbol: "ANTHROPIC", weight: 40 },
          ],
        }),
      )
    ).json()) as { id: string };
    const two = (await (
      await send(
        a,
        "POST",
        "/api/strategies",
        draft({
          name: "Frontier",
          published: true,
          weights: [
            { symbol: "OPENAI", weight: 60 },
            { symbol: "SPACEX", weight: 40 },
          ],
        }),
      )
    ).json()) as { id: string };

    const res = await send(a, "POST", "/api/strategies/overlap", {
      holdings: [
        { strategyId: one.id, usd: 500 },
        { strategyId: two.id, usd: 500 },
      ],
    });
    const body = (await res.json()) as {
      totalUsd: number;
      exposure: { symbol: string; weight: number; usd: number }[];
    };
    expect(body.totalUsd).toBe(1_000);
    // Two "different" baskets, and the user is 60% in one name.
    expect(body.exposure[0]?.symbol).toBe("OPENAI");
    expect(body.exposure[0]?.weight).toBeCloseTo(0.6, 9);
    expect(body.exposure[0]?.usd).toBeCloseTo(600, 9);
  });

  test("rejects an empty or malformed request", async () => {
    const a = app();
    expect((await send(a, "POST", "/api/strategies/overlap", { holdings: [] })).status).toBe(400);
    expect(
      (await send(a, "POST", "/api/strategies/overlap", { holdings: [{ strategyId: "x" }] })).status,
    ).toBe(400);
  });

  test("404s on a strategy that does not exist", async () => {
    const res = await send(app(), "POST", "/api/strategies/overlap", {
      holdings: [{ strategyId: "ghost", usd: 100 }],
    });
    expect(res.status).toBe(404);
  });
});

describe("drift", () => {
  test("reports whether a wallet has drifted past the strategy threshold", async () => {
    const a = app();
    const created = (await (
      await send(a, "POST", "/api/strategies", draft({ guardrails: { driftBps: 300 } }))
    ).json()) as { id: string };

    const inside = (await (
      await send(a, "POST", `/api/strategies/${created.id}/drift`, {
        current: [
          { symbol: "FIGUREAI", weight: 61 },
          { symbol: "NEURALINK", weight: 39 },
        ],
      })
    ).json()) as { exceeded: boolean; worst: { driftBps: number } };
    expect(inside.exceeded).toBe(false);
    expect(inside.worst.driftBps).toBeCloseTo(100, 6);

    const outside = (await (
      await send(a, "POST", `/api/strategies/${created.id}/drift`, {
        current: [
          { symbol: "FIGUREAI", weight: 70 },
          { symbol: "NEURALINK", weight: 30 },
        ],
      })
    ).json()) as { exceeded: boolean };
    expect(outside.exceeded).toBe(true);
  });
});
