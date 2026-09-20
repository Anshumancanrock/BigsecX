/**
 * Wallet authentication for routes that write state a user owns.
 *
 * Before this, a caller simply asserted its own address. That is not a
 * missing feature, it is impersonation: anyone could publish a basket
 * attributed to any wallet, and on a product whose whole premise is ranking
 * traders by verified record, a forged authorship destroys the record.
 *
 * The scheme is the standard one. The client signs a canonical message with
 * the wallet it claims to be, and the server verifies the signature against
 * that public key. Ed25519 is what Solana keys are, and Bun verifies it
 * natively, so this needs no dependency.
 *
 * Two properties beyond "the signature checks out":
 *
 *   Freshness. The message carries a timestamp and is rejected outside a
 *   short window, so a signature captured from one request cannot be replayed
 *   indefinitely.
 *
 *   Binding. The message names the action and the resource, so a signature
 *   authorising one edit cannot be lifted onto a different one.
 */

import { BadRequest } from "./validate.ts";

/** How far a signed message's timestamp may be from ours. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

export class Unauthorized extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unauthorized";
  }
}

export interface SignedAction {
  /** Base58 wallet address claiming the action. */
  readonly wallet: string;
  /** Base64 Ed25519 signature over the canonical message. */
  readonly signature: string;
  /** Milliseconds since epoch, as included in the message. */
  readonly issuedAt: number;
}

/**
 * The exact bytes a client must sign.
 *
 * Kept as one function so the server and any client derive the identical
 * string. A mismatch here fails closed -- verification simply fails -- but it
 * fails confusingly, so there is only one definition.
 */
export function canonicalMessage(args: {
  readonly action: string;
  readonly resource: string;
  readonly wallet: string;
  readonly issuedAt: number;
}): string {
  return [
    "prestocks.basket",
    `action:${args.action}`,
    `resource:${args.resource}`,
    `wallet:${args.wallet}`,
    `issuedAt:${args.issuedAt}`,
  ].join("\n");
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 Solana address to its 32 raw bytes. */
function decodeBase58(value: string): Uint8Array<ArrayBuffer> {
  let big = 0n;
  for (const character of value) {
    const index = BASE58.indexOf(character);
    if (index < 0) throw new BadRequest("wallet is not valid base58");
    big = big * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (big > 0n) {
    bytes.unshift(Number(big % 256n));
    big /= 256n;
  }
  // Each leading '1' encodes a leading zero byte.
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new BadRequest("signature is not valid base64");
  }
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Verify that `wallet` signed this action, recently.
 *
 * Throws Unauthorized on any failure, with a reason that does not reveal
 * which check failed beyond what the caller already knows.
 */
export async function verifySignedAction(
  signed: SignedAction,
  args: { readonly action: string; readonly resource: string; readonly now?: number },
): Promise<void> {
  const now = args.now ?? Date.now();

  if (!Number.isFinite(signed.issuedAt)) {
    throw new Unauthorized("issuedAt must be a timestamp in milliseconds");
  }
  // Symmetric window: a clock ahead of ours is as suspect as one behind.
  if (Math.abs(now - signed.issuedAt) > SIGNATURE_WINDOW_MS) {
    throw new Unauthorized(
      `signature is outside the ${SIGNATURE_WINDOW_MS / 60_000} minute window; sign again`,
    );
  }

  const publicKey = decodeBase58(signed.wallet);
  if (publicKey.length !== 32) throw new Unauthorized("wallet is not a 32-byte public key");

  const signature = decodeBase64(signed.signature);
  if (signature.length !== 64) throw new Unauthorized("signature is not 64 bytes");

  const message: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
    canonicalMessage({
      action: args.action,
      resource: args.resource,
      wallet: signed.wallet,
      issuedAt: signed.issuedAt,
    }),
  );

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
  } catch {
    throw new Unauthorized("wallet is not a valid Ed25519 public key");
  }

  const valid = await crypto.subtle.verify("Ed25519", key, signature, message);
  if (!valid) throw new Unauthorized("signature does not match this wallet and action");
}

/**
 * Pull a signed action out of a request body.
 *
 * Authentication can be disabled with REQUIRE_WALLET_SIGNATURE=0 for local
 * development. It defaults to on: a deployment that forgets to configure it
 * should be secure, not open.
 */
export function signatureRequired(): boolean {
  return process.env["REQUIRE_WALLET_SIGNATURE"] !== "0";
}

export async function authorize(
  body: Record<string, unknown>,
  args: { readonly action: string; readonly resource: string; readonly wallet: string },
): Promise<void> {
  if (!signatureRequired()) return;

  const signature = body["signature"];
  const issuedAt = body["issuedAt"];
  if (typeof signature !== "string" || typeof issuedAt !== "number") {
    throw new Unauthorized(
      "this action must be signed: include signature and issuedAt, over the message from /api/auth/message",
    );
  }

  await verifySignedAction(
    { wallet: args.wallet, signature, issuedAt },
    { action: args.action, resource: args.resource },
  );
}
