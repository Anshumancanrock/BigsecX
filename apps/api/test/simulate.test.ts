import { afterEach, describe, expect, test } from "bun:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createApp } from "../src/app.ts";
import { makeServices, type FakeOptions } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

function app(options: FakeOptions = {}) {
  const services = makeServices(options);
  open.push(services.store);
  return { app: createApp(services), services };
}

const post = (a: ReturnType<typeof createApp>, body: unknown) =>
  a.request("/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The shape the builder emits: a v0 transaction with an empty signature slot. */
function unsigned() {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "9C62FZuEUbpZmFrqPQbNfBiPr5U1JcTBhCfKqGgSEg4m",
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

describe("POST /api/simulate", () => {
  /*
   * There is no testnet: the PreStocks mints exist only on mainnet and Jupiter
   * has no devnet router. Simulating against live state is the substitute, and
   * it must accept unsigned transactions so it can run before anyone signs.
   */
  test("simulates unsigned transactions, which is the entire point", async () => {
    const a = app();
    const res = await post(a.app, { transactions: [unsigned(), unsigned()] });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { wouldLand: boolean; ok: number; results: { ok: boolean; unitsConsumed: number }[] };
    expect(body.wouldLand).toBe(true);
    expect(body.ok).toBe(2);
    expect(body.results.every((r) => r.ok)).toBe(true);
    expect(body.results[0]!.unitsConsumed).toBeGreaterThan(0);
  });

  test("keeps the builder's own blockhash and does not verify signatures", async () => {
    // Substituting the blockhash would hide a stale quote, which is the
    // failure this is most useful for catching.
    const seen: unknown[] = [];
    const a = app();
    const original = a.services.rpc.call.bind(a.services.rpc);
    (a.services.rpc as { call: unknown }).call = async (method: string, params: unknown[] = []) => {
      if (method === "simulateTransaction") seen.push(params[1]);
      return original(method, params);
    };
    await post(a.app, { transactions: [unsigned()] });
    expect(seen[0]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false, encoding: "base64" });
  });

  test("a leg that would fail is named, with its decoded cause and logs", async () => {
    const a = app({ simFailsAt: [1] });
    const res = await post(a.app, { transactions: [unsigned(), unsigned(), unsigned()] });
    const body = (await res.json()) as {
      wouldLand: boolean;
      failed: number;
      results: { index: number; ok: boolean; err?: unknown; logs?: string[] }[];
    };
    expect(body.wouldLand).toBe(false);
    expect(body.failed).toBe(1);
    const bad = body.results.find((r) => !r.ok)!;
    expect(bad.index).toBe(1);
    expect(bad.err).toEqual({ InstructionError: [2, { Custom: 6001 }] });
    expect(bad.logs).toContain("Program failed");
  });

  test("nothing is ever sent", async () => {
    const a = app();
    await post(a.app, { transactions: [unsigned(), unsigned()] });
    expect(a.services.rpc.calls).not.toContain("sendTransaction");
  });

  test("the same wire-format limits as submit still apply", async () => {
    expect((await post(app().app, { transactions: [] })).status).toBe(400);
    expect((await post(app().app, { transactions: ["not base64!!"] })).status).toBe(400);
    expect((await post(app().app, { transactions: [Buffer.alloc(1_300, 7).toString("base64")] })).status).toBe(400);
    expect(
      (await post(app().app, { transactions: Array.from({ length: 21 }, unsigned) })).status,
    ).toBe(400);
  });
});
