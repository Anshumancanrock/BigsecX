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

const post = (a: ReturnType<typeof createApp>, path: string, body: unknown) =>
  a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("read endpoints", () => {
  test("health", async () => {
    const res = await app().app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("universe lists every tradable mint", async () => {
    const res = await app().app.request("/api/universe");
    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toHaveLength(8);
  });

  test("market reports prices, the active fee and the pending change", async () => {
    const res = await app({ priceUsd: { OPENAI: 1_000 } }).app.request("/api/market");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      epoch: number;
      tokens: { symbol: string; transferFeeBps: number; marketUsd: number; basis: number }[];
      pendingFeeChange: { fromBps: number; toBps: number; atEpoch: number };
    };

    expect(body.epoch).toBe(1038);
    // Epoch 1038 is before 1039, so the older 50bps schedule is the live one.
    expect(body.tokens.every((t) => t.transferFeeBps === 50)).toBe(true);
    expect(body.pendingFeeChange).toEqual({ fromBps: 50, toBps: 100, atEpoch: 1039 });

    const openai = body.tokens.find((t) => t.symbol === "OPENAI");
    expect(openai?.marketUsd).toBe(1_000);
    // Mark is 5% above market in the fake, so basis is a discount.
    expect(openai?.basis).toBeCloseTo(1 / 1.05 - 1, 9);
  });

  test("indexes build weights that sum to one", async () => {
    const res = await app().app.request("/api/indexes");
    const body = (await res.json()) as {
      indexes: { id: string; weights: { symbol: string; weight: number }[] | null }[];
    };
    expect(body.indexes.length).toBeGreaterThan(0);
    for (const index of body.indexes) {
      if (!index.weights) continue;
      const total = index.weights.reduce((s, w) => s + w.weight, 0);
      expect(total).toBeCloseTo(1, 9);
    }
  });

  test("a single index returns its definition and history", async () => {
    const res = await app().app.request("/api/indexes/pre8");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; history: unknown[] };
    expect(body.id).toBe("pre8");
    expect(Array.isArray(body.history)).toBe(true);
  });

  test("a paused mint is kept out of every index", async () => {
    const res = await app({ paused: ["SPACEX"] }).app.request("/api/indexes");
    const body = (await res.json()) as {
      indexes: { id: string; weights: { symbol: string }[] | null }[];
    };
    for (const index of body.indexes) {
      expect((index.weights ?? []).map((w) => w.symbol)).not.toContain("SPACEX");
    }
    // defense-space is SpaceX plus Anduril, so it must survive on Anduril.
    const defense = body.indexes.find((i) => i.id === "defense-space");
    expect(defense?.weights?.map((w) => w.symbol)).toEqual(["ANDURIL"]);
  });

  test("an unknown index is a 404, not a crash", async () => {
    const res = await app().app.request("/api/indexes/not-an-index");
    expect(res.status).toBe(404);
  });

  test("leaderboard says so plainly when nothing is indexed", async () => {
    const res = await app().app.request("/api/leaderboard");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; note?: string };
    expect(body.entries).toEqual([]);
    expect(body.note).toContain("no trades");
  });
});

describe("leaderboard over indexed trades", () => {
  /** Seed two wallets: one that bought and gained, one that bought and lost. */
  function seed(store: Store) {
    store.writeTrades([
      // winner bought 100 shares for $5,000; marks at $100 => +$5,000
      { signature: "s1", owner: "winner", symbol: "OPENAI", slot: 10, blockTime: 1, deltaRaw: 1n, uiAmount: 100, valueUsd: 5_000 },
      // loser bought 100 shares for $20,000; marks at $100 => -$10,000
      { signature: "s2", owner: "loser", symbol: "OPENAI", slot: 11, blockTime: 1, deltaRaw: 1n, uiAmount: 100, valueUsd: 20_000 },
      // bagholder only ever sold: cost basis unknown
      { signature: "s3", owner: "bagholder", symbol: "OPENAI", slot: 12, blockTime: 1, deltaRaw: -1n, uiAmount: -500, valueUsd: -50_000 },
    ]);
  }

  test("ranks by profit and excludes wallets with unknown cost basis", async () => {
    const { app: a, services } = app({ priceUsd: { OPENAI: 100 } });
    seed(services.store);

    const res = await a.request("/api/leaderboard?hours=24");
    const body = (await res.json()) as {
      entries: { owner: string; pnlUsd: number; returnFraction: number }[];
      caveats: string[];
    };

    expect(body.entries.map((e) => e.owner)).toEqual(["winner", "loser"]);
    expect(body.entries[0]?.pnlUsd).toBeCloseTo(5_000, 6);
    expect(body.entries[1]?.pnlUsd).toBeCloseTo(-10_000, 6);
    // The loss is measured against capital committed, not against the closing
    // balance, so it is -50% rather than -100%.
    expect(body.entries[1]?.returnFraction).toBeCloseTo(-0.5, 9);
    expect(body.caveats.length).toBeGreaterThan(0);
  });

  test("can rank by return instead of profit", async () => {
    const { app: a, services } = app({ priceUsd: { OPENAI: 100 } });
    seed(services.store);
    const res = await a.request("/api/leaderboard?sortBy=return&limit=1");
    const body = (await res.json()) as { sortBy: string; entries: { owner: string }[] };
    expect(body.sortBy).toBe("return");
    expect(body.entries[0]?.owner).toBe("winner");
  });

  test("an empty query param means unset, not zero", async () => {
    // Any frontend produces "" from an unset form field. Number("") is 0,
    // which clamps to the minimum and silently answers a different question.
    const { app: a, services } = app({ priceUsd: { OPENAI: 100 } });
    seed(services.store);
    const res = await a.request("/api/leaderboard?hours=&limit=&minVolumeUsd=");
    const body = (await res.json()) as { window: string; minVolumeUsd: number };
    expect(body.window).toBe("24h");
    expect(body.minVolumeUsd).toBe(100);
  });

  test("the volume floor can be lowered for a thin dataset", async () => {
    const { app: a, services } = app({ priceUsd: { OPENAI: 100 } });
    services.store.writeTrades([
      { signature: "tiny", owner: "small", symbol: "OPENAI", slot: 5, blockTime: 1, deltaRaw: 1n, uiAmount: 1, valueUsd: 50 },
    ]);
    const hidden = (await (await a.request("/api/leaderboard")).json()) as { entries: unknown[] };
    expect(hidden.entries).toHaveLength(0);

    const shown = (await (await a.request("/api/leaderboard?minVolumeUsd=10")).json()) as {
      entries: { owner: string }[];
    };
    expect(shown.entries.map((e) => e.owner)).toContain("small");
  });


  test("clamps a hostile window instead of failing", async () => {
    const { app: a, services } = app({ priceUsd: { OPENAI: 100 } });
    seed(services.store);
    const res = await a.request("/api/leaderboard?hours=999999&limit=-5");
    expect(res.status).toBe(200);
  });
});

describe("price truth", () => {
  test("falls back to the issuer mark and says why the oracle is absent", async () => {
    const res = await app({ priceUsd: { OPENAI: 1_000 } }).app.request("/api/price-truth");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      oracle: { available: boolean; covered: string[]; note: string };
      tokens: { symbol: string; basisToMark: number; basisToOracle: number | null; verdict: string }[];
    };

    expect(body.oracle.available).toBe(false);
    expect(body.oracle.covered).toEqual([]);
    // A missing oracle column must read as coverage or configuration, never
    // as a price of zero.
    expect(body.oracle.note).toContain("PYTH_API_KEY");

    const openai = body.tokens.find((t) => t.symbol === "OPENAI");
    expect(openai?.basisToOracle).toBeNull();
    // The fake marks 5% above market, so the token is cheap to the mark.
    expect(openai?.basisToMark).toBeCloseTo(1 / 1.05 - 1, 6);
    expect(openai?.verdict).toBe("token-cheap");
  });

  test("covers every token even without an oracle", async () => {
    const body = (await (await app().app.request("/api/price-truth")).json()) as {
      tokens: unknown[];
    };
    expect(body.tokens).toHaveLength(8);
  });
});


describe("mirror/plan validation", () => {
  const cases: [string, unknown, string][] = [
    ["non-numeric deployUsd", { indexId: "prediction", deployUsd: "abc" }, "finite number"],
    ["negative deployUsd", { indexId: "prediction", deployUsd: -5_000 }, "at least 0"],
    ["absurd deployUsd", { indexId: "prediction", deployUsd: 1e30 }, "at most"],
    ["no capital and no holdings", { indexId: "prediction" }, "provide deployUsd"],
    ["null weight", { weights: [{ symbol: "OPENAI", weight: null }], deployUsd: 100 }, "positive finite"],
    ["unknown symbol", { weights: [{ symbol: "NOPE", weight: 1 }], deployUsd: 100 }, "unknown symbol"],
    ["duplicate symbol", { weights: [{ symbol: "OPENAI", weight: 1 }, { symbol: "openai", weight: 1 }], deployUsd: 100 }, "duplicate"],
    ["empty weights", { weights: [], deployUsd: 100 }, "must not be empty"],
    ["unknown index", { indexId: "nope", deployUsd: 100 }, "unknown index"],
    ["neither target", {}, "provide indexId or weights"],
    ["holdings with a bad amount", { indexId: "pre8", holdings: [{ symbol: "OPENAI", uiAmount: -1 }] }, "non-negative"],
  ];

  for (const [name, body, expected] of cases) {
    test(`rejects ${name}`, async () => {
      const res = await post(app().app, "/api/mirror/plan", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(expected);
    });
  }

  test("rejects holdings sized in base units rather than shares", async () => {
    const res = await post(app().app, "/api/mirror/plan", {
      indexId: "pre8",
      holdings: [{ symbol: "OPENAI", uiAmount: 1e15 }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("base units");
  });

  test("rejects weights that individually pass but sum to infinity", async () => {
    // Each value is finite, so a per-entry check lets them through; the sum
    // then normalises every weight to NaN and the plan comes back empty.
    const res = await post(app().app, "/api/mirror/plan", {
      weights: [
        { symbol: "SPACEX", weight: 1e308 },
        { symbol: "OPENAI", weight: 1e308 },
      ],
      deployUsd: 1_000,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("finite");
  });

  test("rejects malformed JSON as a 400, not a 500", async () => {
    const res = await post(app().app, "/api/mirror/plan", "{not json");
    expect(res.status).toBe(400);
  });

  test("rejects a JSON array body", async () => {
    const res = await post(app().app, "/api/mirror/plan", []);
    expect(res.status).toBe(400);
  });
});

describe("mirror/build guards", () => {
  const OWNER = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";

  test("rejects a malformed owner", async () => {
    const res = await post(app().app, "/api/mirror/build", {
      indexId: "pre8",
      deployUsd: 100,
      owner: "notanaddress",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("valid Solana address");
  });

  test("requires an owner", async () => {
    const res = await post(app().app, "/api/mirror/build", { indexId: "pre8", deployUsd: 100 });
    expect(res.status).toBe(400);
  });

  test("refuses a rebalance that funds buys from sells", async () => {
    // Nothing is atomic here, so a buy can land before the sell meant to fund
    // it. Better to refuse than to hand back a bundle that half-executes.
    const res = await post(app().app, "/api/mirror/build", {
      weights: [{ symbol: "POLYMARKET", weight: 1 }],
      deployUsd: 0,
      holdings: [{ symbol: "OPENAI", uiAmount: 20 }],
      owner: OWNER,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      problems: { kind: string; sells?: unknown[]; buys?: unknown[] }[];
    };
    const atomic = body.problems.find((p) => p.kind === "not-atomic");
    expect(atomic).toBeDefined();
    expect((atomic?.sells ?? []).length).toBeGreaterThan(0);
    expect((atomic?.buys ?? []).length).toBeGreaterThan(0);
  });

  test("refuses sell legs the wallet cannot cover", async () => {
    // Holds 20 shares by claim, but the associated token account is empty --
    // exactly the mainnet case that failed with 0x1788 after signing.
    const res = await post(
      app({ balances: { OPENAI: 0n }, priceUsd: { OPENAI: 100, POLYMARKET: 100 } }).app,
      "/api/mirror/build",
      {
        weights: [{ symbol: "POLYMARKET", weight: 1 }],
        deployUsd: 3_000,
        holdings: [{ symbol: "OPENAI", uiAmount: 20 }],
        owner: OWNER,
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      problems: { kind: string; uncovered?: { symbol: string; availableUsd: number }[] }[];
    };
    // Both problems apply here and both must be reported: the shape cannot
    // settle atomically AND the wallet cannot cover the sell.
    expect(body.problems.map((p) => p.kind).sort()).toEqual([
      "insufficient-balance",
      "not-atomic",
    ]);
    const balance = body.problems.find((p) => p.kind === "insufficient-balance");
    expect(balance?.uncovered?.[0]?.symbol).toBe("OPENAI");
    expect(balance?.uncovered?.[0]?.availableUsd).toBe(0);
  });

  test("refuses when the wallet has no USDC for the buy legs", async () => {
    // Sell legs were checked against the chain while buys were checked
    // against nothing, so an empty wallet still received a signable bundle.
    const res = await post(app({ usdcRaw: 0n }).app, "/api/mirror/build", {
      indexId: "pre8",
      deployUsd: 5_000,
      owner: OWNER,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { problems: { kind: string }[] };
    expect(body.problems.map((p) => p.kind)).toContain("insufficient-usdc");
  });

  test("refuses when the wallet has no SOL for fees", async () => {
    // USDC alone is not enough: every transaction pays a signature fee and
    // may open accounts.
    const res = await post(app({ lamports: 0 }).app, "/api/mirror/build", {
      indexId: "pre8",
      deployUsd: 1_000,
      owner: OWNER,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { problems: { kind: string }[] };
    expect(body.problems.map((p) => p.kind)).toContain("insufficient-sol");
  });

  test("refuses when part of the wallet cannot be valued", async () => {
    // An unpriced holding is silently worth zero to the rebalancer, which
    // then sizes every other leg against a portfolio value that is too low.
    const res = await post(app({ pricesThrow: true }).app, "/api/mirror/build", {
      weights: [{ symbol: "POLYMARKET", weight: 1 }],
      deployUsd: 1_000,
      holdings: [{ symbol: "OPENAI", uiAmount: 20 }],
      owner: OWNER,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { problems: { kind: string; symbols?: string[] }[] };
    const unpriced = body.problems.find((p) => p.kind === "unpriced-holding");
    expect(unpriced?.symbols).toEqual(["OPENAI"]);
  });


  test("refuses a basket containing a paused mint", async () => {
    // The issuer holds pause authority on every mint. A paused mint is not
    // merely illiquid; every swap touching it fails.
    const res = await post(app({ paused: ["SPACEX"] }).app, "/api/mirror/build", {
      weights: [{ symbol: "SPACEX", weight: 1 }],
      deployUsd: 1_000,
      owner: OWNER,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { problems: { kind: string; symbols?: string[] }[] };
    expect(body.problems.find((p) => p.kind === "paused")?.symbols).toEqual(["SPACEX"]);
  });


  test("refuses when there is nothing to trade", async () => {
    const res = await post(app().app, "/api/mirror/build", {
      indexId: "pre8",
      deployUsd: 0,
      holdings: [],
      owner: OWNER,
    });
    expect(res.status).toBe(400);
  });
});

describe("plan and build agree", () => {
  /**
   * Regression. The planning endpoint resized legs for depth and impact and
   * deferred the ones the pools could not absorb; the build endpoint then
   * sent the raw unresized orders. A user saw "NEURALINK reduced, KALSHI
   * deferred" and signed a bundle doing neither -- the entire execution
   * policy existed only in the preview.
   */
  test("a build that can price nothing refuses rather than bundling raw orders", async () => {
    const res = await post(app({ usdcRaw: 100_000_000_000n }).app, "/api/mirror/build", {
      indexId: "prediction",
      deployUsd: 1_000,
      owner: "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { problems: { kind: string; deferred?: unknown[] }[] };
    const problem = body.problems.find((p) => p.kind === "no-executable-legs");
    expect(problem).toBeDefined();
    // The legs that could not be executed are named, not swallowed.
    expect(Array.isArray(problem?.deferred)).toBe(true);
  });
});


describe("failure handling", () => {
  test("a price-feed failure degrades instead of taking the API down", async () => {
    // Every route depends on a snapshot. Letting a Jupiter 429 reject the
    // whole call 500s the entire API on a cold cache -- the exact condition
    // seen when the indexer died on a rate limit.
    const res = await app({ pricesThrow: true }).app.request("/api/market");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      priceFeedError: string | null;
      degraded: string[];
      tokens: { symbol: string; marketUsd: number | null; transferFeeBps: number }[];
    };
    // The failure is reported rather than hidden behind empty prices.
    expect(body.priceFeedError).toBeTruthy();
    expect(body.degraded).toHaveLength(8);
    expect(body.tokens.every((t) => t.marketUsd === null)).toBe(true);
    // Chain-derived facts still hold: those did not depend on the feed.
    expect(body.tokens.every((t) => t.transferFeeBps === 50)).toBe(true);
  });

  test("indexes survive a price-feed failure without inventing weights", async () => {
    const res = await app({ pricesThrow: true }).app.request("/api/indexes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      indexes: { id: string; weights: { symbol: string; weight: number }[] | null }[];
    };
    // Valuation weighting has nothing to weigh, so those indexes report no
    // basket rather than an arbitrary one. Equal-weighted ones still stand.
    const equal = body.indexes.find((i) => i.id === "embodied");
    expect(equal?.weights?.length).toBe(2);
  });

  test("an internal failure does not leak its message to the caller", async () => {
    // Chain state is not optional, so a failure there is a real 500.
    const services = makeServices();
    open.push(services.store);
    services.rpc.call = (async () => {
      throw new Error("secret internal detail 429 at /var/run");
    }) as typeof services.rpc.call;

    const res = await createApp(services).request("/api/market");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal error");
    expect(body.error).not.toContain("secret");
  });
});
