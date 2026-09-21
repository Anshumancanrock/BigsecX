import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/index.ts";
import { bodyDigest, canonicalMessage } from "../src/auth.ts";
import { TestWallet, makeServices } from "./fakes.ts";
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

const alice = new TestWallet();
const bob = new TestWallet();
const ALICE = alice.address;
const BOB = bob.address;

const send = (a: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  a.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Sign as Alice for an action, merging the proof into a request body. */
async function signed(
  wallet: TestWallet,
  action: string,
  resource: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // The signature covers the body it will be sent with, including creator.
  const full = { ...body, creator: wallet.address };
  return { ...full, ...(await wallet.sign(action, resource, full)) };
}

const draftBody = (over: Record<string, unknown> = {}) => ({
  name: "Humanoid Revolution",
  description: "robots that act on the world",
  weights: [
    { symbol: "FIGUREAI", weight: 60 },
    { symbol: "NEURALINK", weight: 40 },
  ],
  ...over,
});

/** A signed create request from Alice. */
const draft = async (over: Record<string, unknown> = {}) =>
  signed(alice, "create-strategy", "new", draftBody(over));

describe("creating strategies", () => {
  test("stores exactly the allocation the author asked for", async () => {
    const res = await send(app(), "POST", "/api/strategies", await draft());
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
      await draft({
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
      await draft({
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
    const res = await send(app(), "POST", "/api/strategies", await draft({ weights: [{ symbol: "NVDA", weight: 1 }, { symbol: "OPENAI", weight: 1 }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown symbol");
  });

  test("requires a valid creator address", async () => {
    const res = await send(app(), "POST", "/api/strategies", {
      ...draftBody(),
      creator: "nope",
      signature: "AA==",
      issuedAt: Date.now(),
    });
    expect(res.status).toBe(400);
  });

  test("rejects an unknown rebalance frequency", async () => {
    const res = await send(app(), "POST", "/api/strategies", await draft({ rebalance: "hourly" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("rebalance must be");
  });

  test("rejects a guardrail outside 0..1", async () => {
    const res = await send(app(), "POST", "/api/strategies", await draft({ guardrails: { maxWeight: 40 } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("fraction");
  });
});

describe("authentication", () => {
  /**
   * Before signatures, a caller asserted its own address. That was not a
   * missing feature but forgery: anyone could publish a basket attributed to
   * any wallet, and on a product that ranks traders by verified record a
   * forged authorship destroys the record.
   */
  test("refuses to attribute a strategy to a wallet the caller cannot sign for", async () => {
    // Alice signs, but claims to be Bob.
    const body = { ...draftBody(), creator: bob.address };
    const proof = await alice.sign("create-strategy", "new", body);
    const res = await send(app(), "POST", "/api/strategies", { ...body, ...proof });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("does not match");
  });

  test("refuses an unsigned mutation", async () => {
    const res = await send(app(), "POST", "/api/strategies", {
      ...draftBody(),
      creator: alice.address,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("must be signed");
  });

  test("refuses a stale signature", async () => {
    // Replaying a captured signature indefinitely must not work.
    const body = { ...draftBody(), creator: alice.address };
    const stale = await alice.sign("create-strategy", "new", body, Date.now() - 60 * 60_000);
    const res = await send(app(), "POST", "/api/strategies", { ...body, ...stale });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("window");
  });

  test("refuses a signature bound to a different action", async () => {
    // A signature authorising a delete must not authorise a create.
    const body = { ...draftBody(), creator: alice.address };
    const wrong = await alice.sign("delete-strategy", "new", body);
    const res = await send(app(), "POST", "/api/strategies", { ...body, ...wrong });
    expect(res.status).toBe(401);
  });

  test("refuses a signature bound to a different resource", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", await draft())).json()) as {
      id: string;
    };
    // Signed for a different strategy id.
    const res = await send(
      a,
      "DELETE",
      `/api/strategies/${created.id}`,
      await signed(alice, "delete-strategy", "some-other-id", {}),
    );
    expect(res.status).toBe(401);
  });

  test("refuses a signature replayed with a different body", async () => {
    // Without the body in the signed bytes, one captured signature is an
    // arbitrary write primitive for the whole freshness window: it can
    // publish baskets under the victim's wallet and rewrite their own.
    const honest = { ...draftBody(), creator: alice.address };
    const proof = await alice.sign("create-strategy", "new", honest);
    expect((await send(app(), "POST", "/api/strategies", { ...honest, ...proof })).status).toBe(201);

    const tampered = {
      ...draftBody({
        name: "Rugpull",
        published: true,
        weights: [
          { symbol: "KALSHI", weight: 50 },
          { symbol: "SPACEX", weight: 50 },
        ],
      }),
      creator: alice.address,
    };
    const res = await send(app(), "POST", "/api/strategies", { ...tampered, ...proof });
    expect(res.status).toBe(401);
  });

  test("refuses the same signature twice", async () => {
    // Even with identical content: a create would otherwise mint a second
    // basket, because the id carries a fresh random suffix each time.
    const a = app();
    const body = { ...draftBody(), creator: alice.address };
    const proof = await alice.sign("create-strategy", "new", body);
    expect((await send(a, "POST", "/api/strategies", { ...body, ...proof })).status).toBe(201);
    const replay = await send(a, "POST", "/api/strategies", { ...body, ...proof });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toContain("already been used");
  });

  test("refuses a future-dated signature", async () => {
    // Allowing the full window forward would double every signature's life.
    const body = { ...draftBody(), creator: alice.address };
    const future = await alice.sign("create-strategy", "new", body, Date.now() + 4 * 60_000);
    const res = await send(app(), "POST", "/api/strategies", { ...body, ...future });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("future");
  });

  test("serves the exact message a client must sign, including the body", async () => {
    const payload = { ...draftBody(), creator: alice.address };
    const res = await send(app(), "POST", "/api/auth/message", {
      action: "create-strategy",
      resource: "new",
      wallet: alice.address,
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; issuedAt: number; required: boolean };
    expect(body.message).toContain("action:create-strategy");
    expect(body.message).toContain(`wallet:${alice.address}`);
    // The body digest is part of the signed bytes, so a client deriving the
    // message without it would fail verification with nothing to debug.
    expect(body.message).toMatch(/\nbody:[0-9a-f]{64}$/);
    expect(body.required).toBe(true);
  });

  test("the served message matches what the client would derive", async () => {
    const a = app();
    const payload = { ...draftBody(), creator: alice.address };
    const served = (await (
      await send(a, "POST", "/api/auth/message", {
        action: "create-strategy",
        resource: "new",
        wallet: alice.address,
        body: payload,
      })
    ).json()) as { message: string; issuedAt: number };

    const mine = canonicalMessage({
      action: "create-strategy",
      resource: "new",
      wallet: alice.address,
      issuedAt: served.issuedAt,
      bodyDigest: await bodyDigest(payload),
    });
    expect(mine).toBe(served.message);
  });

  test("reads are not gated", async () => {
    expect((await app().request("/api/strategies")).status).toBe(200);
  });
});

describe("visibility and ownership", () => {
  test("a draft is private to its author", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", await draft())).json()) as { id: string };

    const publicList = (await (await a.request("/api/strategies")).json()) as { strategies: unknown[] };
    expect(publicList.strategies).toHaveLength(0);

    // A wallet address is public, so filtering by creator must NOT expose
    // that wallet's unpublished work.
    const byCreator = (await (await a.request(`/api/strategies?creator=${ALICE}`)).json()) as {
      strategies: unknown[];
    };
    expect(byCreator.strategies).toHaveLength(0);

    // Reading your own drafts requires proving the wallet is yours.
    const mine = (await (
      await send(a, "POST", "/api/strategies/mine", await signed(alice, "list-drafts", "mine", {}))
    ).json()) as { strategies: { id: string }[] };
    expect(mine.strategies.map((s) => s.id)).toEqual([created.id]);
  });

  test("publishing makes it visible to everyone", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", await draft({ published: true }))).json()) as {
      id: string;
    };
    const list = (await (await a.request("/api/strategies")).json()) as { strategies: { id: string }[] };
    expect(list.strategies.map((s) => s.id)).toEqual([created.id]);
  });

  test("another wallet cannot edit it", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", await draft())).json()) as { id: string };
    const res = await send(
      a,
      "PUT",
      `/api/strategies/${created.id}`,
      await signed(bob, "update-strategy", created.id, {
        name: "Stolen",
        weights: [
          { symbol: "OPENAI", weight: 1 },
          { symbol: "ANTHROPIC", weight: 1 },
        ],
      }),
    );
    expect(res.status).toBe(403);
  });

  test("another wallet cannot delete it", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", await draft())).json()) as { id: string };
    expect(
      (
        await send(
          a,
          "DELETE",
          `/api/strategies/${created.id}`,
          await signed(bob, "delete-strategy", created.id, {}),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          a,
          "DELETE",
          `/api/strategies/${created.id}`,
          await signed(alice, "delete-strategy", created.id, {}),
        )
      ).status,
    ).toBe(200);
    expect((await a.request(`/api/strategies/${created.id}`)).status).toBe(404);
  });

  test("an unknown id is a 404 on every route", async () => {
    const a = app();
    expect((await a.request("/api/strategies/nope")).status).toBe(404);
    expect(
      (await send(a, "PUT", "/api/strategies/nope", await signed(alice, "update-strategy", "nope", draftBody()))).status,
    ).toBe(404);
    expect(
      (await send(a, "DELETE", "/api/strategies/nope", await signed(alice, "delete-strategy", "nope", {}))).status,
    ).toBe(404);
  });
});

describe("response consistency", () => {
  test("the create response equals a subsequent read", async () => {
    // Timestamps persist to the second, so echoing the in-memory value gave
    // the caller a createdAt that changed on the next fetch.
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", await draft())).json()) as {
      id: string;
    };
    const fetched = await (await a.request(`/api/strategies/${created.id}`)).json();
    expect(fetched).toEqual(created);
  });
});

describe("a published strategy can be bought", () => {
  /**
   * The product's loop. Authoring and execution were built separately and
   * never joined: a user could create a basket, publish it, and then find no
   * way to buy it, because the mirror routes accepted only a system index id
   * or inline weights and answered "unknown index" for a strategy id.
   */
  test("its id resolves as a mirror target", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", await draft({ published: true }))).json()) as {
      id: string;
      weights: { symbol: string; weight: number }[];
    };

    const plan = await send(a, "POST", "/api/mirror/plan", {
      strategyId: created.id,
      deployUsd: 1_000,
    });
    expect(plan.status).toBe(200);
    const body = (await plan.json()) as {
      target: string;
      targetSource: string;
      weights: { symbol: string; weight: number }[];
    };
    expect(body.targetSource).toBe("strategy");
    expect(body.target).toBe("Humanoid Revolution");
    expect(body.weights).toEqual(created.weights);
  });

  test("a draft cannot be bought, and says why", async () => {
    const a = app();
    const created = (await (await send(a, "POST", "/api/strategies", await draft())).json()) as {
      id: string;
    };
    const res = await send(a, "POST", "/api/mirror/plan", {
      strategyId: created.id,
      deployUsd: 1_000,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("publish it");
  });

  test("an unknown strategy id is refused", async () => {
    const res = await send(app(), "POST", "/api/mirror/plan", {
      strategyId: "ghost",
      deployUsd: 1_000,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown strategy");
  });
});

describe("drafts are private", () => {
  test("another wallet cannot list them even with a signature", async () => {
    const a = app();
    await send(a, "POST", "/api/strategies", await draft());
    const bobs = (await (
      await send(a, "POST", "/api/strategies/mine", await signed(bob, "list-drafts", "mine", {}))
    ).json()) as { strategies: unknown[] };
    expect(bobs.strategies).toHaveLength(0);
  });

  test("listing drafts requires a signature", async () => {
    const a = app();
    await send(a, "POST", "/api/strategies", await draft());
    const res = await send(a, "POST", "/api/strategies/mine", { creator: ALICE });
    expect(res.status).toBe(401);
  });
});

describe("editing", () => {
  test("an edit keeps the original creation time and the stored guardrails", async () => {
    const a = app();
    const created = (await (
      await send(a, "POST", "/api/strategies", await draft({ guardrails: { maxWeight: 0.7, driftBps: 111 } }))
    ).json()) as { id: string; createdAt: string };

    const updated = (await (
      await send(a, "PUT", `/api/strategies/${created.id}`, await signed(alice, "update-strategy", created.id, { name: "Renamed" }))
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

describe("retracting", () => {
  test("a creator can unpublish a strategy", async () => {
    // Or-ing the request with the stored value made publication permanent.
    const a = app();
    const created = (await (
      await send(a, "POST", "/api/strategies", await draft({ published: true }))
    ).json()) as { id: string };
    expect(((await (await a.request("/api/strategies")).json()) as { strategies: unknown[] }).strategies).toHaveLength(1);

    const updated = (await (
      await send(a, "PUT", `/api/strategies/${created.id}`, await signed(alice, "update-strategy", created.id, { published: false }))
    ).json()) as { published: boolean };
    expect(updated.published).toBe(false);
    expect(((await (await a.request("/api/strategies")).json()) as { strategies: unknown[] }).strategies).toHaveLength(0);
  });

  test("omitting published leaves it as it was", async () => {
    const a = app();
    const created = (await (
      await send(a, "POST", "/api/strategies", await draft({ published: true }))
    ).json()) as { id: string };
    const updated = (await (
      await send(a, "PUT", `/api/strategies/${created.id}`, await signed(alice, "update-strategy", created.id, { name: "Renamed" }))
    ).json()) as { published: boolean };
    expect(updated.published).toBe(true);
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
        await draft({
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
        await draft({
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

  test("caps the number of holdings it will price", async () => {
    // Each entry costs a database read; without a cap this is a cheap
    // denial of service.
    const many = Array.from({ length: 5_000 }, () => ({ strategyId: "x", usd: 1 }));
    const res = await send(app(), "POST", "/api/strategies/overlap", { holdings: many });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("at most");
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
      await send(a, "POST", "/api/strategies", await draft({ guardrails: { driftBps: 300 } }))
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
