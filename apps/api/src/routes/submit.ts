/**
 * Relay for signed transactions, and their status. Public RPC endpoints reject
 * browser origins and rate limit per IP, and a paid endpoint's key cannot ship
 * to the browser. Only well-formed, correctly signed transactions are relayed.
 */

import type { Hono } from "hono";
import { VersionedTransaction } from "@solana/web3.js";
import { RpcFailure, encodeBase58 } from "@ps/chain";
import type { Services } from "../context.ts";
import { BadRequest, readJson } from "../lib/validate.ts";

/**
 * Copy onto a plain ArrayBuffer. WebCrypto takes a BufferSource, which a view
 * over a SharedArrayBuffer or a pooled Node Buffer does not satisfy.
 */
function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

/** A versioned transaction cannot exceed this on the wire. */
const MAX_TRANSACTION_BYTES = 1232;

/** More than any basket needs, and too few to make this a bulk relay. */
const MAX_TRANSACTIONS = 20;

/** Most signatures one status request may ask about. */
const MAX_SIGNATURES = 40;

interface Parsed {
  readonly index: number;
  readonly base64: string;
  readonly signature: string;
}

/**
 * Check that every required signature signs this message. An RPC node accepts
 * a transaction with a bogus signature and returns a signature for it, but it
 * never lands; checking here turns that into an immediate 400.
 */
async function verifySignatures(transaction: VersionedTransaction, index: number): Promise<void> {
  const message = transaction.message.serialize();
  const required = transaction.message.header.numRequiredSignatures;

  for (let i = 0; i < required; i++) {
    const signature = transaction.signatures[i];
    const signer = transaction.message.staticAccountKeys[i];
    if (!signature || !signer) {
      throw new BadRequest(`transactions[${index}] is missing signature ${i}`);
    }
    if (signature.every((byte) => byte === 0)) {
      throw new BadRequest(`transactions[${index}] is not signed`);
    }

    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("raw", copy(signer.toBytes()), "Ed25519", false, ["verify"]);
    } catch {
      throw new BadRequest(`transactions[${index}] signer ${i} is not a valid Ed25519 key`);
    }

    const valid = await crypto.subtle.verify("Ed25519", key, copy(signature), copy(message));
    if (!valid) {
      throw new BadRequest(
        `transactions[${index}] signature ${i} does not sign this message; it would never land`,
      );
    }
  }
}

/**
 * Decode one transaction and derive its first signature, checking the wire
 * format only (base64, size, deserialisation), since simulation takes unsigned
 * transactions. Errors name the offending index.
 */
function parseTransactionShape(raw: unknown, index: number): Parsed & { transaction: VersionedTransaction } {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new BadRequest(`transactions[${index}] must be a base64 string`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new BadRequest(`transactions[${index}] is not base64`);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64");
  } catch {
    throw new BadRequest(`transactions[${index}] is not base64`);
  }
  if (bytes.length === 0) throw new BadRequest(`transactions[${index}] is empty`);
  if (bytes.length > MAX_TRANSACTION_BYTES) {
    throw new BadRequest(
      `transactions[${index}] is ${bytes.length} bytes, over the ${MAX_TRANSACTION_BYTES} byte limit`,
    );
  }

  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(bytes);
  } catch (error) {
    throw new BadRequest(
      `transactions[${index}] is not a versioned transaction: ${(error as Error).message}`,
    );
  }

  const signature = transaction.signatures[0];
  if (!signature) throw new BadRequest(`transactions[${index}] carries no signature slot`);

  return { index, base64: raw, signature: encodeBase58(signature), transaction };
}

/** Everything parseTransactionShape checks, plus: it must actually be signed. */
function parseTransaction(raw: unknown, index: number): Parsed & { transaction: VersionedTransaction } {
  const parsed = parseTransactionShape(raw, index);
  // An unsigned transaction serialises with a zero-filled signature slot.
  if (parsed.transaction.signatures[0]?.every((byte) => byte === 0)) {
    throw new BadRequest(`transactions[${index}] is not signed`);
  }
  return parsed;
}

/** A base58 transaction signature: 64 bytes, usually 86-88 characters. */
function parseSignature(raw: unknown, index: number): string {
  if (typeof raw !== "string" || raw.length < 64 || raw.length > 96) {
    throw new BadRequest(`signatures[${index}] is not a transaction signature`);
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(raw)) {
    throw new BadRequest(`signatures[${index}] is not base58`);
  }
  return raw;
}

function parseArray(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequest(`${field} must be a non-empty array`);
  }
  if (value.length > max) {
    throw new BadRequest(`${field} holds ${value.length} entries, over the limit of ${max}`);
  }
  return value;
}

export interface SubmitResult {
  readonly index: number;
  readonly signature: string;
  readonly submitted: boolean;
  readonly error?: string;
  /** The simulated error the node reported, when it reported one. */
  readonly err?: unknown;
  /** The tail of the program logs, which is where the cause is. */
  readonly logs?: readonly string[];
}

export function registerSubmitRoutes(app: Hono, services: Services): void {
  /**
   * Simulate a bundle on mainnet, where the mints and routes exist, without
   * submitting it. It runs unsigned (`sigVerify: false`) and keeps the builder's
   * blockhash (`replaceRecentBlockhash: false`) so a stale quote still fails.
   */
  app.post("/api/simulate", async (c) => {
    const body = await readJson(c);
    const raw = parseArray(body["transactions"], "transactions", MAX_TRANSACTIONS);

    // Wire-format checks only: transactions here are expected to be unsigned.
    const parsed = raw.map(parseTransactionShape);

    const settled = await Promise.allSettled(
      parsed.map((entry) =>
        services.rpc.call<{
          value: {
            err: unknown;
            logs: string[] | null;
            unitsConsumed?: number;
          };
        }>("simulateTransaction", [
          entry.base64,
          {
            encoding: "base64",
            sigVerify: false,
            replaceRecentBlockhash: false,
            commitment: "confirmed",
          },
        ]),
      ),
    );

    const results = settled.map((outcome, i) => {
      const index = parsed[i]!.index;
      if (outcome.status !== "fulfilled") {
        return { index, ok: false, error: (outcome.reason as Error)?.message ?? "simulation failed" };
      }
      const value = outcome.value?.value;
      if (value?.err) {
        return {
          index,
          ok: false,
          err: value.err,
          // The tail is where the cause is; the head is invoke noise.
          logs: (value.logs ?? []).slice(-8),
          unitsConsumed: value.unitsConsumed ?? null,
        };
      }
      return { index, ok: true, unitsConsumed: value?.unitsConsumed ?? null };
    });

    const failed = results.filter((r) => !r.ok);
    return c.json({
      results,
      wouldLand: failed.length === 0,
      ok: results.length - failed.length,
      failed: failed.length,
      note:
        "Executed against live mainnet state and discarded. Nothing was submitted and nothing was spent. " +
        "It cannot predict a price move between now and landing.",
    });
  });

  /**
   * Relay signed transactions to the cluster. Results are per transaction, and
   * a failed send still reports the locally derived signature.
   */
  app.post("/api/submit", async (c) => {
    const body = await readJson(c);
    const raw = parseArray(body["transactions"], "transactions", MAX_TRANSACTIONS);
    const parsed = raw.map(parseTransaction);
    // Sequential, so verification stops at the first bad transaction.
    for (const entry of parsed) await verifySignatures(entry.transaction, entry.index);

    // Preflight is on by default: one simulation round trip buys a real error
    // message instead of a failed transaction the user pays for.
    const skipPreflight = body["skipPreflight"] === true;

    // Sent concurrently: builds refuse buys funded by sells, so a bundle's
    // transactions are independent, and a queue would spend the blockhash's life.
    const settled = await Promise.allSettled(
      parsed.map((entry) =>
        services.rpc.call<string>("sendTransaction", [
          entry.base64,
          {
            encoding: "base64",
            skipPreflight,
            preflightCommitment: "confirmed",
            // Let the node rebroadcast into the next few slots.
            maxRetries: 3,
          },
        ]),
      ),
    );

    const results: SubmitResult[] = settled.map((outcome, i) => {
      const entry = parsed[i]!;
      if (outcome.status === "fulfilled") {
        return { index: entry.index, signature: outcome.value, submitted: true };
      }
      return {
        index: entry.index,
        // The locally derived signature: a send that failed may still land,
        // so the client can poll for it.
        signature: entry.signature,
        submitted: false,
        ...explain(outcome.reason),
      };
    });

    return c.json({
      results,
      submitted: results.filter((r) => r.submitted).length,
      failed: results.filter((r) => !r.submitted).length,
    });
  });

  /**
   * The status of each signature, with the current block height so a client
   * can tell "not landed yet" from "expired" (past lastValidBlockHeight).
   */
  app.post("/api/confirm", async (c) => {
    const body = await readJson(c);
    const raw = parseArray(body["signatures"], "signatures", MAX_SIGNATURES);
    const signatures = raw.map(parseSignature);

    const [statusResponse, blockHeight] = await Promise.all([
      services.rpc.call<{
        value: ({ slot: number; confirmationStatus: string | null; err: unknown } | null)[];
      }>("getSignatureStatuses", [signatures, { searchTransactionHistory: true }]),
      services.rpc.call<number>("getBlockHeight", [{ commitment: "confirmed" }]),
    ]);

    const statuses = signatures.map((signature, i) => {
      const entry = statusResponse.value[i] ?? null;
      if (!entry) return { signature, status: "unknown" as const, slot: null, err: null };
      if (entry.err) {
        return {
          signature,
          status: "failed" as const,
          slot: entry.slot,
          // Verbatim: the program error code is what explains the failure.
          err: entry.err,
        };
      }
      return {
        signature,
        status: (entry.confirmationStatus ?? "processed") as "processed" | "confirmed" | "finalized",
        slot: entry.slot,
        err: null,
      };
    });

    return c.json({ blockHeight, statuses });
  });
}

/**
 * A send failure with the node's simulated `err` and log tail attached, which
 * name the cause. Passed through unsummarised: the custom error code is what a
 * reader looks up.
 */
function explain(reason: unknown): { error: string; err?: unknown; logs?: readonly string[] } {
  const message = (reason as Error)?.message ?? "send failed";
  if (!(reason instanceof RpcFailure) || !reason.rpcError) return { error: message };

  const data = reason.rpcError.data as
    | { err?: unknown; logs?: unknown; unitsConsumed?: number }
    | undefined;
  if (!data) return { error: message };

  const logs = Array.isArray(data.logs)
    ? // The tail is where the failure is; the head is invoke noise.
      (data.logs as string[]).slice(-6)
    : undefined;

  return {
    error: message,
    ...(data.err === undefined ? {} : { err: data.err }),
    ...(logs === undefined ? {} : { logs }),
  };
}
