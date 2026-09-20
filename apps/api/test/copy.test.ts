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

const LEADER = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const FOLLOWER = "4acSCrTSNXQPHVENCJNXaVmBhuFPNrDRYCqLLNqJvuQY";
const raw = (ui: number, multiplier = 1) => BigInt(Math.round((ui / multiplier) * 1e9));

const post = (a: ReturnType<typeof createApp>, path: string, body: unknown) =>
  a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Leader holding 60% OPENAI / 40% SPACEX by value. */
const leaderBook: FakeOptions = {
  balances: { OPENAI: raw(6, 1.4861347), SPACEX: raw(4, 5) },
  priceUsd: { OPENAI: 100, SPACEX: 100 },
};

describe("copy preview", () => {
  test("mirrors the leader's weights, scaled to the follower's capital", async () => {
    const body = (await (
      await post(app(leaderBook), "/api/copy/preview", { leader: LEADER, capitalUsd: 1_000 })
    ).json()) as {
      deployUsd: number;
      positions: { symbol: string; weight: number; usd: number }[];
      custody: string;
    };

    expect(body.deployUsd).toBe(1_000);
    expect(body.positions.find((p) => p.symbol === "OPENAI")?.usd).toBeCloseTo(600, 4);
    expect(body.positions.find((p) => p.symbol === "SPACEX")?.usd).toBeCloseTo(400, 4);
    expect(body.custody).toContain("Non-custodial");
  });

  test("a copy ratio holds part of the capital back as stablecoin", async () => {
    const body = (await (
      await post(app(leaderBook), "/api/copy/preview", {
        leader: LEADER,
        capitalUsd: 1_000,
        copyRatio: 0.25,
      })
    ).json()) as { deployUsd: number; reserveUsd: number; positions: { usd: number }[] };

    expect(body.deployUsd).toBe(250);
    expect(body.reserveUsd).toBe(750);
    expect(body.positions.reduce((s, p) => s + p.usd, 0)).toBeCloseTo(250, 6);
  });

  test("names every excluded position instead of dropping it quietly", async () => {
    const body = (await (
      await post(app(leaderBook), "/api/copy/preview", {
        leader: LEADER,
        capitalUsd: 1_000,
        excludeSymbols: ["SPACEX"],
      })
    ).json()) as {
      positions: { symbol: string; usd: number }[];
      excluded: { symbol: string; reason: string }[];
    };

    expect(body.positions.map((p) => p.symbol)).toEqual(["OPENAI"]);
    // The refused weight is redistributed, not left as unexplained cash.
    expect(body.positions[0]?.usd).toBeCloseTo(1_000, 4);
    expect(body.excluded[0]?.reason).toContain("excluded by the follower");
  });

  test("drops a paused mint and says the issuer halted it", async () => {
    const body = (await (
      await post(app({ ...leaderBook, paused: ["SPACEX"] }), "/api/copy/preview", {
        leader: LEADER,
        capitalUsd: 1_000,
      })
    ).json()) as { excluded: { symbol: string; reason: string }[] };
    expect(body.excluded[0]?.symbol).toBe("SPACEX");
    expect(body.excluded[0]?.reason).toContain("halted");
  });

  test("a leader holding nothing is explained, not an error", async () => {
    const res = await post(app(), "/api/copy/preview", { leader: LEADER, capitalUsd: 1_000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { positions: unknown[]; notes: string[] };
    expect(body.positions).toHaveLength(0);
    expect(body.notes.join(" ")).toContain("nothing to copy");
  });

  test("rejects bad limits", async () => {
    const a = app(leaderBook);
    for (const bad of [
      { leader: LEADER },
      { leader: LEADER, capitalUsd: 0 },
      { leader: LEADER, capitalUsd: 1_000, copyRatio: 2 },
      { leader: LEADER, capitalUsd: 1_000, maxPositionWeight: 0 },
      { leader: "nope", capitalUsd: 1_000 },
      { leader: LEADER, capitalUsd: 1_000, excludeSymbols: ["NVDA"] },
    ]) {
      expect((await post(a, "/api/copy/preview", bad)).status).toBe(400);
    }
  });
});

describe("copy build", () => {
  test("refuses a wallet copying itself", async () => {
    const res = await post(app(leaderBook), "/api/copy/build", {
      leader: LEADER,
      follower: LEADER,
      capitalUsd: 1_000,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("cannot copy itself");
  });

  test("runs the same refusals as any other build", async () => {
    // Follower has no USDC, so the copy must be refused exactly as an index
    // mirror would be.
    const res = await post(app({ ...leaderBook, usdcRaw: 0n }), "/api/copy/build", {
      leader: LEADER,
      follower: FOLLOWER,
      capitalUsd: 5_000,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { problems: { kind: string }[] };
    expect(body.problems.map((p) => p.kind)).toContain("insufficient-usdc");
  });

  test("refuses when the follower cannot pay fees", async () => {
    const res = await post(app({ ...leaderBook, lamports: 0 }), "/api/copy/build", {
      leader: LEADER,
      follower: FOLLOWER,
      capitalUsd: 1_000,
    });
    expect(res.status).toBe(409);
    expect(
      ((await res.json()) as { problems: { kind: string }[] }).problems.map((p) => p.kind),
    ).toContain("insufficient-sol");
  });

  test("refuses when the leader holds nothing copyable", async () => {
    const res = await post(app(), "/api/copy/build", {
      leader: LEADER,
      follower: FOLLOWER,
      capitalUsd: 1_000,
    });
    expect(res.status).toBe(409);
  });

  test("refuses when every position is excluded", async () => {
    const res = await post(app(leaderBook), "/api/copy/build", {
      leader: LEADER,
      follower: FOLLOWER,
      capitalUsd: 1_000,
      excludeSymbols: ["OPENAI", "SPACEX"],
    });
    expect(res.status).toBe(409);
  });
});

describe("preview matches build", () => {
  /**
   * Regression for the worst bug found in review.
   *
   * Copy build passed the follower's existing holdings into the rebalancer
   * alongside the capital, so the target became (existing + capital). A
   * follower holding $5,000 elsewhere saw a preview promising $600 and $400
   * and received a bundle selling $5,000 of an untouched position and buying
   * $3,600 and $2,400 -- six times the size, liquidating a holding they had
   * never agreed to sell, after approving the preview.
   *
   * The invariant that prevents it is proven in packages/core: deploying
   * capital with no holdings yields exactly weight x capital in buys. Here
   * we check the route never reports a sell-shaped refusal, which is what
   * leaked holdings would produce.
   */
  test("a copy of new capital never trips a sell-shaped refusal", async () => {
    const a = app({ ...leaderBook, usdcRaw: 100_000_000_000n });
    const res = await post(a, "/api/copy/build", {
      leader: LEADER,
      follower: FOLLOWER,
      capitalUsd: 1_000,
    });
    const body = (await res.json()) as { problems?: { kind: string }[] };

    // The fake cannot quote, so every leg defers and the build refuses --
    // which is itself correct: nothing should be bundled that could not be
    // priced. What matters is the reason. Selling or non-atomicity would
    // mean the follower's holdings had leaked into the target.
    const kinds = (body.problems ?? []).map((p) => p.kind);
    expect(kinds).not.toContain("not-atomic");
    expect(kinds).not.toContain("insufficient-balance");
    expect(kinds).toContain("no-executable-legs");
  });

  test("the preview is sized from capital alone", async () => {
    const a = app({ ...leaderBook, usdcRaw: 100_000_000_000n });
    const preview = (await (
      await post(a, "/api/copy/preview", { leader: LEADER, capitalUsd: 1_000 })
    ).json()) as { deployUsd: number; positions: { usd: number }[] };

    expect(preview.deployUsd).toBe(1_000);
    expect(preview.positions.reduce((s, p) => s + p.usd, 0)).toBeCloseTo(1_000, 6);
  });
});

describe("stop check", () => {
  test("measures drawdown from the peak", async () => {
    const body = (await (
      await post(app(), "/api/copy/stop-check", {
        peakValueUsd: 2_000,
        currentValueUsd: 1_600,
        stopLossFraction: 0.15,
      })
    ).json()) as { drawdownFraction: number; triggered: boolean; action: string };

    expect(body.drawdownFraction).toBeCloseTo(0.2, 9);
    expect(body.triggered).toBe(true);
    // Stopping needs no on-chain action, because no authority was granted.
    expect(body.action).toContain("No on-chain action");
  });

  test("does not fire inside the limit", async () => {
    const body = (await (
      await post(app(), "/api/copy/stop-check", {
        peakValueUsd: 1_000,
        currentValueUsd: 950,
        stopLossFraction: 0.15,
      })
    ).json()) as { triggered: boolean };
    expect(body.triggered).toBe(false);
  });

  test("rejects a stop loss outside 0..1", async () => {
    const res = await post(app(), "/api/copy/stop-check", {
      peakValueUsd: 1_000,
      currentValueUsd: 900,
      stopLossFraction: 1,
    });
    expect(res.status).toBe(400);
  });
});
