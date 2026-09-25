import { afterEach, describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createApp } from "../src/app.ts";
import { decodeBase58, encodeBase58 } from "@ps/chain";
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

const BLOCKHASH = "9C62FZuEUbpZmFrqPQbNfBiPr5U1JcTBhCfKqGgSEg4m";

/** A real, signable v0 transaction, in the shape the builder produces. */
function makeTransaction(options: { sign?: boolean; payer?: Keypair; lamports?: number } = {}) {
  const payer = options.payer ?? Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: options.lamports ?? 1_000,
      }),
    ],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  if (options.sign !== false) transaction.sign([payer]);
  return {
    payer,
    transaction,
    base64: Buffer.from(transaction.serialize()).toString("base64"),
    signature: encodeBase58(transaction.signatures[0]!),
  };
}

describe("POST /api/submit", () => {
  test("relays every transaction and returns the cluster's signatures", async () => {
    const a = app();
    const txs = [makeTransaction(), makeTransaction(), makeTransaction()];

    const res = await post(a.app, "/api/submit", { transactions: txs.map((t) => t.base64) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      submitted: number;
      failed: number;
      results: { index: number; signature: string; submitted: boolean }[];
    };
    expect(body.submitted).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(body.results.every((r) => r.submitted)).toBe(true);
    expect(a.services.rpc.calls.filter((c) => c === "sendTransaction")).toHaveLength(3);
  });

  test("a failed send does not fail the others, and still yields a pollable signature", async () => {
    // This is the whole reason the signature is derived locally. A send that
    // errors may still have landed; reporting failure without a signature
    // would leave the client unable to ever find out.
    const a = app({ sendFailsAt: [1] });
    const txs = [makeTransaction(), makeTransaction(), makeTransaction()];

    const res = await post(a.app, "/api/submit", { transactions: txs.map((t) => t.base64) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      submitted: number;
      failed: number;
      results: { index: number; signature: string; submitted: boolean; error?: string }[];
    };
    expect(body.submitted).toBe(2);
    expect(body.failed).toBe(1);

    const failed = body.results.find((r) => !r.submitted)!;
    expect(failed.index).toBe(1);
    expect(failed.error).toContain("Blockhash not found");
    // Derived from the transaction, not invented.
    expect(failed.signature).toBe(txs[1]!.signature);
    expect(decodeBase58(failed.signature)).toHaveLength(64);
  });

  test("the derived signature is the transaction's own first signature", async () => {
    const a = app({ sendFailsAt: [0] });
    const tx = makeTransaction();
    const res = await post(a.app, "/api/submit", { transactions: [tx.base64] });
    const body = (await res.json()) as { results: { signature: string }[] };
    expect([...decodeBase58(body.results[0]!.signature)]).toEqual([...tx.transaction.signatures[0]!]);
  });

  test("refuses an unsigned transaction rather than paying an RPC round trip to learn it", async () => {
    const a = app();
    const unsigned = makeTransaction({ sign: false });
    const res = await post(a.app, "/api/submit", { transactions: [unsigned.base64] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not signed");
    expect(a.services.rpc.calls).not.toContain("sendTransaction");
  });

  test("refuses a forged signature, rather than relaying something that can never land", async () => {
    // An RPC node accepts 64 random bytes in the signature slot and returns a
    // signature, but the transaction never confirms, which looks like a slow
    // network to the user. The relay rejects it up front.
    const a = app();
    const tx = makeTransaction();
    const forged = VersionedTransaction.deserialize(Buffer.from(tx.base64, "base64"));
    forged.signatures[0] = crypto.getRandomValues(new Uint8Array(64));

    const res = await post(a.app, "/api/submit", {
      transactions: [Buffer.from(forged.serialize()).toString("base64")],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("does not sign this message");
    expect(a.services.rpc.calls).not.toContain("sendTransaction");
  });

  test("refuses a signature that is valid but signs a different message", async () => {
    // Lifting a real signature off one transaction and onto another is the
    // version of the above an attacker would actually try.
    const a = app();
    const payer = Keypair.generate();
    const one = makeTransaction({ payer, lamports: 1_000 });
    const two = makeTransaction({ payer, lamports: 2_000 });

    const swapped = VersionedTransaction.deserialize(Buffer.from(two.base64, "base64"));
    swapped.signatures[0] = VersionedTransaction.deserialize(
      Buffer.from(one.base64, "base64"),
    ).signatures[0]!;

    const res = await post(a.app, "/api/submit", {
      transactions: [Buffer.from(swapped.serialize()).toString("base64")],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("does not sign this message");
  });

  test("a genuinely signed transaction passes verification", async () => {
    // The guard above must not reject real traffic; every other test in this
    // file signs properly and reaching the RPC is what proves it.
    const a = app();
    const res = await post(a.app, "/api/submit", { transactions: [makeTransaction().base64] });
    expect(res.status).toBe(200);
    expect(a.services.rpc.calls).toContain("sendTransaction");
  });

  test("names the offending index so a six-transaction basket is debuggable", async () => {
    const good = makeTransaction();
    const res = await post(app().app, "/api/submit", {
      transactions: [good.base64, good.base64, "not base64!!"],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("transactions[2]");
  });

  test("refuses bytes that are not a versioned transaction", async () => {
    const a = app();
    const junk = Buffer.from("this is not a transaction at all").toString("base64");
    const res = await post(a.app, "/api/submit", { transactions: [junk] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/versioned transaction|not signed/);
    expect(a.services.rpc.calls).not.toContain("sendTransaction");
  });

  test("refuses anything over the 1232-byte wire limit", async () => {
    const oversized = Buffer.alloc(1_300, 7).toString("base64");
    const res = await post(app().app, "/api/submit", { transactions: [oversized] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("1232 byte limit");
  });

  test("refuses an empty array and refuses to be used as a bulk relay", async () => {
    const tx = makeTransaction();
    expect((await post(app().app, "/api/submit", { transactions: [] })).status).toBe(400);
    expect((await post(app().app, "/api/submit", {})).status).toBe(400);
    const flood = await post(app().app, "/api/submit", {
      transactions: Array.from({ length: 21 }, () => tx.base64),
    });
    expect(flood.status).toBe(400);
    expect((await flood.json()).error).toContain("limit of 20");
  });

  test("preflight is on unless the caller turns it off", async () => {
    const seen: unknown[] = [];
    const a = app();
    const original = a.services.rpc.call.bind(a.services.rpc);
    (a.services.rpc as { call: unknown }).call = async (method: string, params: unknown[] = []) => {
      if (method === "sendTransaction") seen.push(params[1]);
      return original(method, params);
    };

    await post(a.app, "/api/submit", { transactions: [makeTransaction().base64] });
    expect((seen[0] as { skipPreflight: boolean }).skipPreflight).toBe(false);

    await post(a.app, "/api/submit", {
      transactions: [makeTransaction().base64],
      skipPreflight: true,
    });
    expect((seen[1] as { skipPreflight: boolean }).skipPreflight).toBe(true);
  });
});

describe("POST /api/confirm", () => {
  const sigA = encodeBase58(crypto.getRandomValues(new Uint8Array(64)));
  const sigB = encodeBase58(crypto.getRandomValues(new Uint8Array(64)));

  test("reports the status of each signature alongside the block height", async () => {
    const a = app({
      blockHeight: 426_629_400,
      statuses: {
        [sigA]: { slot: 42, confirmationStatus: "confirmed", err: null },
        [sigB]: { slot: 43, confirmationStatus: "finalized", err: null },
      },
    });

    const res = await post(a.app, "/api/confirm", { signatures: [sigA, sigB] });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      blockHeight: number;
      statuses: { signature: string; status: string; slot: number | null }[];
    };
    // The client needs this to tell "not landed yet" from "expired".
    expect(body.blockHeight).toBe(426_629_400);
    expect(body.statuses).toEqual([
      { signature: sigA, status: "confirmed", slot: 42, err: null },
      { signature: sigB, status: "finalized", slot: 43, err: null },
    ]);
  });

  test("an on-chain error surfaces verbatim, because the code is the explanation", async () => {
    const err = { InstructionError: [0, { Custom: 6001 }] };
    const a = app({ statuses: { [sigA]: { slot: 9, confirmationStatus: "confirmed", err } } });

    const res = await post(a.app, "/api/confirm", { signatures: [sigA] });
    const body = (await res.json()) as { statuses: { status: string; err: unknown }[] };
    expect(body.statuses[0]!.status).toBe("failed");
    expect(body.statuses[0]!.err).toEqual(err);
  });

  test("a signature the cluster has never seen is unknown, not confirmed", async () => {
    const res = await post(app().app, "/api/confirm", { signatures: [sigA] });
    const body = (await res.json()) as { statuses: { status: string; slot: number | null }[] };
    expect(body.statuses[0]!.status).toBe("unknown");
    expect(body.statuses[0]!.slot).toBeNull();
  });

  test("keeps request order even though the cluster answers as a set", async () => {
    const a = app({
      statuses: {
        [sigA]: { slot: 1, confirmationStatus: "confirmed", err: null },
        [sigB]: { slot: 2, confirmationStatus: "confirmed", err: null },
      },
    });
    const res = await post(a.app, "/api/confirm", { signatures: [sigB, sigA] });
    const body = (await res.json()) as { statuses: { signature: string }[] };
    expect(body.statuses.map((s) => s.signature)).toEqual([sigB, sigA]);
  });

  test("refuses anything that is not a transaction signature", async () => {
    for (const bad of [["short"], ["0".repeat(88)], [123], []]) {
      const res = await post(app().app, "/api/confirm", { signatures: bad });
      expect(res.status).toBe(400);
    }
  });
});
