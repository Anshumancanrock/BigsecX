import { describe, expect, test } from "bun:test";
import { fetchTrades, getSignaturesSince, type SignatureRef } from "../src/trades.ts";

/**
 * A fake node holding a fixed signature history, newest first, honouring the
 * `until` and `before` bounds the real RPC does.
 */
function fakeRpc(history: readonly string[]) {
  const calls: { until?: string; before?: string; limit: number }[] = [];
  return {
    calls,
    call: async <T>(_method: string, params: unknown[] = []): Promise<T> => {
      const [, options] = params as [string, { limit: number; until?: string; before?: string }];
      calls.push({ ...options });

      let start = 0;
      if (options.before) start = history.indexOf(options.before) + 1;

      let end = history.length;
      if (options.until) {
        const stop = history.indexOf(options.until);
        if (stop >= 0) end = stop;
      }

      const page = history.slice(start, Math.min(end, start + options.limit));
      return page.map<SignatureRef>((signature, i) => ({
        signature,
        slot: 1_000 - history.indexOf(signature),
        blockTime: 1_700_000_000 - i,
        err: null,
      })) as T;
    },
  };
}

// Newest first, as the RPC returns them.
const HISTORY = Array.from({ length: 25 }, (_, i) => `sig${i}`);

describe("getSignaturesSince", () => {
  test("returns a short page and reports the scan as complete", async () => {
    const rpc = fakeRpc(HISTORY.slice(0, 3));
    const { signatures, complete } = await getSignaturesSince(rpc as never, "mint", {
      pageSize: 10,
    });
    expect(signatures.map((s) => s.signature)).toEqual(["sig0", "sig1", "sig2"]);
    expect(complete).toBe(true);
  });

  test("pages backward to close the gap above a cursor", async () => {
    // Twelve signatures newer than the cursor, four per page: a single page
    // would silently skip eight of them.
    const rpc = fakeRpc(HISTORY);
    const { signatures, complete } = await getSignaturesSince(rpc as never, "mint", {
      until: "sig12",
      pageSize: 4,
      maxPages: 5,
    });
    expect(signatures).toHaveLength(12);
    expect(signatures.map((s) => s.signature)).toEqual(HISTORY.slice(0, 12));
    expect(complete).toBe(true);
    expect(rpc.calls.every((c) => c.until === "sig12")).toBe(true);
  });

  test("reports an incomplete scan when the page budget runs out", async () => {
    const rpc = fakeRpc(HISTORY);
    const { signatures, complete } = await getSignaturesSince(rpc as never, "mint", {
      pageSize: 4,
      maxPages: 2,
    });
    expect(signatures).toHaveLength(8);
    // The caller must not advance a cursor past this, or it skips the rest.
    expect(complete).toBe(false);
  });

  test("a bootstrap scan of deep history is always incomplete", async () => {
    // No cursor means no lower bound, so the page budget always runs out; the
    // indexer must special-case a first run or it never writes a cursor.
    const rpc = fakeRpc(HISTORY);
    const { complete } = await getSignaturesSince(rpc as never, "mint", {
      until: undefined,
      pageSize: 6,
      maxPages: 3,
    });
    expect(complete).toBe(false);
  });

  test("stops cleanly when the cursor is the newest signature", async () => {
    const rpc = fakeRpc(HISTORY);
    const { signatures, complete } = await getSignaturesSince(rpc as never, "mint", {
      until: "sig0",
      pageSize: 10,
    });
    expect(signatures).toHaveLength(0);
    expect(complete).toBe(true);
  });
});

describe("a cursor the node no longer holds", () => {
  test("starts again from the newest page and reports the gap", async () => {
    // Free endpoints keep a short history. A cursor saved days ago names a
    // transaction they no longer have, and the node refuses the whole call.
    const inner = fakeRpc(HISTORY.slice(0, 3));
    const rpc = {
      call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
        const [, options] = params as [string, { until?: string }];
        if (options.until === "pruned") throw new Error("getSignaturesForAddress: Transaction pruned not found");
        return inner.call<T>(method, params);
      },
    };
    const result = await getSignaturesSince(rpc as never, "addr", { until: "pruned", pageSize: 10 });
    expect(result.signatures.map((s) => s.signature)).toEqual(["sig0", "sig1", "sig2"]);
    expect(result.complete).toBe(false);
  });

  test("other failures still surface", async () => {
    const rpc = {
      call: async () => {
        throw new Error("HTTP 500");
      },
    };
    await expect(getSignaturesSince(rpc as never, "addr", { until: "x" })).rejects.toThrow("HTTP 500");
  });
});

describe("fetching transactions from a node that refuses batches", () => {
  test("falls back to one call at a time and loses nothing", async () => {
    // The default endpoint allows one getTransaction per batch.
    let batches = 0;
    let singles = 0;
    const rpc = {
      batch: async () => {
        batches++;
        throw new Error("Maximum number of 'getTransaction' calls in a batch request is 1");
      },
      call: async () => {
        singles++;
        return null;
      },
    };
    const { missed } = await fetchTrades(rpc as never, ["a", "b", "c", "d", "e"], new Set(), { batchSize: 2 });
    expect(missed).toBe(0);
    expect(singles).toBe(5);
    // One refusal is enough to stop trying batches for the rest of the run.
    expect(batches).toBe(1);
  });

  test("counts a failed single call as missed, so the cursor stays put", async () => {
    const rpc = {
      batch: async () => {
        throw new Error("refused");
      },
      call: async (_m: string, params: unknown[] = []) => {
        if (params[0] === "b") throw new Error("HTTP 429");
        return null;
      },
    };
    const { missed } = await fetchTrades(rpc as never, ["a", "b", "c"], new Set());
    expect(missed).toBe(1);
  });
});
