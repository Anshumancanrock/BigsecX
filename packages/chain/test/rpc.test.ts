import { afterAll, expect, test } from "bun:test";
import { Rpc, RpcFailure, rpcUrls } from "../src/rpc.ts";

let hits = 0;
let status = 403;
const server = Bun.serve({
  port: 0,
  fetch() {
    hits++;
    return Response.json(
      { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Indexed requests require a personal token." } },
      { status },
    );
  },
});
afterAll(() => server.stop(true));

test("a client refusal fails at once instead of being retried", async () => {
  hits = 0;
  status = 403;
  const rpc = new Rpc({ url: `http://localhost:${server.port}` });
  const started = performance.now();
  const error = await rpc.call("getTokenAccountsByOwner").catch((e) => e);
  expect(error).toBeInstanceOf(RpcFailure);
  expect((error as RpcFailure).rpcError?.message).toContain("personal token");
  expect(hits).toBe(1);
  expect(performance.now() - started).toBeLessThan(300);
});

test("rate limiting is still retried", async () => {
  hits = 0;
  status = 429;
  const rpc = new Rpc({ url: `http://localhost:${server.port}`, maxRetries: 2 });
  await rpc.call("getSlot").catch(() => {});
  expect(hits).toBe(3);
});

/** A node that answers every call with `result`, counting what it serves. */
function answering(result: unknown) {
  const node = {
    served: 0,
    server: Bun.serve({
      port: 0,
      async fetch(request) {
        node.served++;
        const body = (await request.json()) as { id: number };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    }),
  };
  return node;
}

/** A node that refuses every call the way publicnode refuses indexed ones. */
function refusing() {
  const node = {
    asked: 0,
    server: Bun.serve({
      port: 0,
      fetch() {
        node.asked++;
        return Response.json(
          { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Indexed requests require a personal token." } },
          { status: 403 },
        );
      },
    }),
  };
  return node;
}

test("an unreachable endpoint is passed over at once for the next", async () => {
  // A port that was just freed: connecting to it is refused.
  const gone = Bun.serve({ port: 0, fetch: () => new Response("") });
  const goneUrl = `http://localhost:${gone.port}`;
  gone.stop(true);
  const live = answering(7);
  try {
    const rpc = new Rpc({ url: [goneUrl, `http://localhost:${live.server.port}`] });
    const started = performance.now();
    expect(await rpc.call<number>("getSlot")).toBe(7);
    // No backoff: the second endpoint was asked straight away.
    expect(performance.now() - started).toBeLessThan(300);
    // The next call starts with the endpoint that answered.
    const again = performance.now();
    expect(await rpc.call<number>("getSlot")).toBe(7);
    expect(performance.now() - again).toBeLessThan(100);
    expect(live.served).toBe(2);
  } finally {
    live.server.stop(true);
  }
});

test("a method one endpoint refuses is asked of the next, and the refusal is remembered", async () => {
  const picky = refusing();
  const full = answering("accounts");
  try {
    // Named in one comma-separated string, as SOLANA_RPC_URL may name them.
    const rpc = new Rpc({ url: `http://localhost:${picky.server.port}, http://localhost:${full.server.port}` });
    expect(await rpc.call<string>("getTokenAccountsByOwner")).toBe("accounts");
    expect(await rpc.call<string>("getTokenAccountsByOwner")).toBe("accounts");
    expect(picky.asked).toBe(1);
    expect(full.served).toBe(2);
  } finally {
    picky.server.stop(true);
    full.server.stop(true);
  }
});

test("a method every endpoint refuses fails with the refusal, each asked once", async () => {
  const a = refusing();
  const b = refusing();
  try {
    const rpc = new Rpc({ url: [`http://localhost:${a.server.port}`, `http://localhost:${b.server.port}`] });
    const error = await rpc.call("getTokenAccountsByOwner").catch((e) => e);
    expect(error).toBeInstanceOf(RpcFailure);
    expect((error as RpcFailure).rpcError?.message).toContain("personal token");
    expect(a.asked + b.asked).toBe(2);
  } finally {
    a.server.stop(true);
    b.server.stop(true);
  }
});

test("an endpoint list is split, trimmed and deduplicated", () => {
  expect(rpcUrls(" https://a , https://b,https://a,")).toEqual(["https://a", "https://b"]);
  expect(rpcUrls(["https://a"])).toEqual(["https://a"]);
  expect(() => new Rpc({ url: " , " })).toThrow();
});
