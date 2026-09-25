import { describe, expect, test } from "bun:test";
import { Cache, RateLimiter } from "../src/http.ts";

describe("Cache", () => {
  test("serves a value within its ttl without calling the loader again", async () => {
    const cache = new Cache();
    let calls = 0;
    const load = async () => {
      calls++;
      return calls;
    };
    expect(await cache.fetch("k", 10_000, load)).toBe(1);
    expect(await cache.fetch("k", 10_000, load)).toBe(1);
    expect(calls).toBe(1);
  });

  test("reloads once the ttl has passed", async () => {
    const cache = new Cache();
    let calls = 0;
    const load = async () => ++calls;
    await cache.fetch("k", 1, load);
    await new Promise((r) => setTimeout(r, 5));
    await cache.fetch("k", 1, load);
    expect(calls).toBe(2);
  });

  test("single-flights concurrent misses into one upstream call", async () => {
    const cache = new Cache();
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return "v";
    };
    const all = await Promise.all(Array.from({ length: 50 }, () => cache.fetch("k", 10_000, load)));
    expect(calls).toBe(1);
    expect(all.every((v) => v === "v")).toBe(true);
  });

  test("serves a stale value when the loader fails", async () => {
    const cache = new Cache();
    expect(await cache.fetch("k", 1, async () => "fresh")).toBe("fresh");
    await new Promise((r) => setTimeout(r, 5));
    const value = await cache.fetch<string>("k", 1, async () => {
      throw new Error("upstream down");
    });
    expect(value).toBe("fresh");
  });

  test("revalidating in the background returns the old value at once and reloads behind it", async () => {
    const cache = new Cache();
    await cache.fetch("k", 1, async () => "old", 60_000);
    await new Promise((r) => setTimeout(r, 5));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = async () => {
      calls++;
      await gate;
      return "new";
    };
    // Expired: both callers get the old value without waiting on the reload,
    // and the reload is shared between them.
    expect(await cache.fetch("k", 10_000, slow, 60_000, { revalidateInBackground: true })).toBe("old");
    expect(await cache.fetch("k", 10_000, slow, 60_000, { revalidateInBackground: true })).toBe("old");
    expect(calls).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.fetch("k", 10_000, slow, 60_000, { revalidateInBackground: true })).toBe("new");
    expect(calls).toBe(1);
  });

  test("a failed background reload keeps the old value and raises nothing", async () => {
    const cache = new Cache();
    await cache.fetch("k", 1, async () => "old", 60_000);
    await new Promise((r) => setTimeout(r, 5));
    const failing = async (): Promise<string> => {
      throw new Error("upstream down");
    };
    expect(await cache.fetch("k", 1, failing, 60_000, { revalidateInBackground: true })).toBe("old");
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.fetch("k", 1, failing, 60_000, { revalidateInBackground: true })).toBe("old");
  });

  test("revalidating in the background still waits when there is nothing to serve", async () => {
    const cache = new Cache();
    expect(await cache.fetch("cold", 1_000, async () => "v", 1_000, { revalidateInBackground: true })).toBe("v");
  });

  test("propagates the failure when there is nothing stale to serve", async () => {
    const cache = new Cache();
    await expect(
      cache.fetch<string>("cold", 1_000, async () => {
        throw new Error("upstream down");
      }),
    ).rejects.toThrow("upstream down");
  });

  test("evicts oldest-first so distinct keys cannot grow without bound", async () => {
    // Quote keys embed the trade amount, so every request mints a new key.
    const cache = new Cache(50);
    for (let i = 0; i < 500; i++) await cache.fetch(`k${i}`, 60_000, async () => i);
    expect(cache.size).toBe(50);

    let reloaded = false;
    await cache.fetch("k0", 60_000, async () => {
      reloaded = true;
      return -1;
    });
    expect(reloaded).toBe(true);

    // The newest entry survived.
    let touched = false;
    await cache.fetch("k499", 60_000, async () => {
      touched = true;
      return -1;
    });
    expect(touched).toBe(false);
  });
});

describe("RateLimiter", () => {
  test("allows a burst up to capacity immediately", async () => {
    const limiter = new RateLimiter(5, 1);
    const started = Date.now();
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("makes a caller wait once the bucket is empty", async () => {
    const limiter = new RateLimiter(1, 20); // refills in ~50ms
    await limiter.acquire();
    const started = Date.now();
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
