import { describe, expect, test } from "bun:test";
import { getSignaturesSince, type SignatureRef } from "../src/trades.ts";

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
    // This is the shape that broke the indexer: with no cursor there is no
    // lower bound, so the page budget always runs out and `complete` is
    // always false. The job must treat a first run as a special case or the
    // cursor is never written and every pass re-scans the same signatures.
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
