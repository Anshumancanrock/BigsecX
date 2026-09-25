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

const json = (a: ReturnType<typeof createApp>, path: string, body: unknown) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function publishOne(a: ReturnType<typeof createApp>, wallet: TestWallet, published: boolean) {
  const payload = {
    creator: wallet.address,
    name: published ? "Public Basket" : "Secret Basket",
    description: "the confidential part",
    weights: [{ symbol: "OPENAI", weight: 1 }, { symbol: "SPACEX", weight: 1 }],
    rebalance: "manual",
    published,
  };
  const signed = await wallet.sign("create-strategy", "new", payload);
  const res = await json(a, "/api/strategies", { ...payload, ...signed });
  return (await res.json()) as { id: string };
}

describe("draft privacy", () => {
  /*
   * The detail endpoint must hide drafts the same way the list endpoint does:
   * ids derive from the name and are partly guessable.
   */
  test("an unpublished basket is 404 to everyone, including by direct id", async () => {
    const a = app();
    const author = new TestWallet();
    const { id } = await publishOne(a, author, false);

    const direct = await a.request(`/api/strategies/${id}`);
    // 404 rather than 403: do not confirm that the id exists either.
    expect(direct.status).toBe(404);
    expect(await direct.text()).not.toContain("confidential");

    for (const path of ["/api/strategies", `/api/strategies?creator=${author.address}`]) {
      expect(await (await a.request(path)).text()).not.toContain("Secret Basket");
    }
  });

  test("its own author can still read it, with a signature", async () => {
    const a = app();
    const author = new TestWallet();
    await publishOne(a, author, false);

    const body = { creator: author.address };
    const signed = await author.sign("list-drafts", "mine", body);
    const res = await json(a, "/api/strategies/mine", { ...body, ...signed });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Secret Basket");
  });

  test("another wallet cannot read them even with its own valid signature", async () => {
    const a = app();
    const author = new TestWallet();
    const stranger = new TestWallet();
    await publishOne(a, author, false);

    const body = { creator: stranger.address };
    const signed = await stranger.sign("list-drafts", "mine", body);
    const res = await json(a, "/api/strategies/mine", { ...body, ...signed });
    expect(res.status).toBe(200);
    // A valid signature proves identity, not read access.
    expect(await res.text()).not.toContain("Secret Basket");
  });

  /*
   * Every route that reads a strategy goes through publicStrategy(): drift,
   * overlap and the portfolio comparison must not expose a draft's name or
   * weights any more than GET /api/strategies/:id does.
   */
  test("drift does not reveal an unpublished basket's target allocation", async () => {
    const a = app();
    const { id } = await publishOne(a, new TestWallet(), false);
    const res = await json(a, `/api/strategies/${id}/drift`, {
      current: [{ symbol: "OPENAI", weight: 1 }],
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("SPACEX");
    expect(text).not.toContain("0.5");
  });

  test("overlap does not reveal an unpublished basket's name or exposure", async () => {
    const a = app();
    const { id } = await publishOne(a, new TestWallet(), false);
    const res = await json(a, "/api/strategies/overlap", {
      holdings: [{ strategyId: id, usd: 1000 }],
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Secret Basket");
  });

  test("a portfolio comparison does not reveal an unpublished basket", async () => {
    const a = app();
    const { id } = await publishOne(a, new TestWallet(), false);
    const res = await a.request(
      `/api/portfolio/GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL?compare=${id}`,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Secret Basket");
  });

  test("mirroring a draft is refused, and says why rather than leaking it", async () => {
    const a = app();
    const { id } = await publishOne(a, new TestWallet(), false);
    const res = await json(a, "/api/mirror/plan", { strategyId: id, deployUsd: 100 });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("draft");
    expect(text).not.toContain("SPACEX");
  });

  test("every one of those routes still works on a published basket", async () => {
    const a = app();
    const { id } = await publishOne(a, new TestWallet(), true);

    expect((await a.request(`/api/strategies/${id}`)).status).toBe(200);
    expect(
      (await json(a, `/api/strategies/${id}/drift`, { current: [{ symbol: "OPENAI", weight: 1 }] })).status,
    ).toBe(200);
    expect(
      (await json(a, "/api/strategies/overlap", { holdings: [{ strategyId: id, usd: 1000 }] })).status,
    ).toBe(200);
    expect(
      (await a.request(`/api/portfolio/GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL?compare=${id}`)).status,
    ).toBe(200);
  });

  test("a published basket stays readable by anyone", async () => {
    const a = app();
    const { id } = await publishOne(a, new TestWallet(), true);
    const res = await a.request(`/api/strategies/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Public Basket");
  });
});
