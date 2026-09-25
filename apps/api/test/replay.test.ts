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

const send = (a: ReturnType<typeof createApp>, body: unknown) =>
  a.request("/api/strategies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("single-use signatures", () => {
  /*
   * Replay protection must key on the decoded signature bytes: atob accepts
   * several spellings of the same 64 bytes, so keying on the string would let
   * a re-spaced signature be used again within the freshness window.
   */
  test("the same signature cannot be replayed by re-spelling its base64", async () => {
    const a = app();
    const wallet = new TestWallet();
    const payload = {
      creator: wallet.address,
      name: "Replay Target",
      weights: [{ symbol: "OPENAI", weight: 1 }, { symbol: "KALSHI", weight: 1 }],
      rebalance: "manual",
      published: true,
    };
    const proof = (await wallet.sign("create-strategy", "new", payload)) as {
      signature: string;
      issuedAt: number;
    };

    expect((await send(a, { ...payload, ...proof })).status).toBe(201);

    const spellings: [string, string][] = [
      ["identical", proof.signature],
      ["padding stripped", proof.signature.replace(/=+$/, "")],
      ["leading space", ` ${proof.signature}`],
      ["trailing newline", `${proof.signature}\n`],
      ["both", ` ${proof.signature.replace(/=+$/, "")}\n`],
    ];

    for (const [label, signature] of spellings) {
      const res = await send(a, { ...payload, ...proof, signature });
      expect(res.status, `${label} must not be accepted`).toBe(401);
      expect(await res.text()).toContain("already been used");
    }
  });

  test("a genuinely different signature is still accepted", async () => {
    // The canonical key must not over-collapse and lock out real requests.
    const a = app();
    const wallet = new TestWallet();
    for (let i = 0; i < 3; i++) {
      const payload = {
        creator: wallet.address,
        name: `Distinct ${i}`,
        weights: [{ symbol: "OPENAI", weight: 1 }, { symbol: "KALSHI", weight: 1 }],
        rebalance: "manual",
        published: true,
      };
      const proof = await wallet.sign("create-strategy", "new", payload);
      expect((await send(a, { ...payload, ...proof })).status).toBe(201);
    }
  });
});

describe("canonical message integrity", () => {
  /*
   * The message is newline-delimited, so a field containing a newline could
   * inject extra fields. Verification rebuilds the message from server
   * constants, so this is not exploitable, but such fields are still refused.
   */
  test("a field carrying a newline cannot inject another line", async () => {
    const a = app();
    const wallet = new TestWallet();
    const res = await a.request("/api/auth/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create-strategy\nwallet:SomeoneElse",
        resource: "new",
        wallet: wallet.address,
        body: {},
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("control characters");
  });

  test("carriage returns and other control characters are refused too", async () => {
    const a = app();
    const wallet = new TestWallet();
    for (const action of ["a\rb", "a\u0000b", "a\u001bb", "a\u007fb"]) {
      const res = await a.request("/api/auth/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, resource: "new", wallet: wallet.address, body: {} }),
      });
      expect(res.status, JSON.stringify(action)).toBe(400);
    }
  });

  test("an ordinary action still produces a message", async () => {
    const a = app();
    const wallet = new TestWallet();
    const res = await a.request("/api/auth/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create-strategy", resource: "new", wallet: wallet.address, body: {} }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: string }).message).toContain("action:create-strategy");
  });
});
