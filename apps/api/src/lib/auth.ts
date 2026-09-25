/**
 * Ed25519 wallet signatures for routes that write state a wallet owns. A
 * signed message is time-limited, bound to the action, the resource and a
 * digest of the request body, and accepted only once.
 */

import { decodeBase58 as sharedDecodeBase58 } from "@ps/chain";
import { BadRequest } from "./validate.ts";

/** Maximum age of a signed message's timestamp. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;
/** Forward allowance for a client clock running fast. */
export const CLOCK_SKEW_MS = 30_000;

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
 * Refuse control characters in a message field. The message is
 * newline-delimited, so a newline in a field could inject extra lines, such as
 * a second `wallet:`.
 */
function rejectDelimiters(value: string, field: string): string {
  if (/[\r\n\u0000-\u001F\u007F]/.test(value)) {
    throw new BadRequest(`${field} must not contain control characters`);
  }
  return value;
}

/** The exact message a client signs. The single definition, so server and clients cannot diverge. */
export function canonicalMessage(args: {
  readonly action: string;
  readonly resource: string;
  readonly wallet: string;
  readonly issuedAt: number;
  /** Hex sha256 of the request body. Empty for actions that carry none. */
  readonly bodyDigest?: string;
}): string {
  return [
    "prestocks.basket",
    `action:${rejectDelimiters(args.action, "action")}`,
    `resource:${rejectDelimiters(args.resource, "resource")}`,
    `wallet:${args.wallet}`,
    `issuedAt:${args.issuedAt}`,
    `body:${args.bodyDigest ?? ""}`,
  ].join("\n");
}

/**
 * Hex SHA-256 of a request body, with keys sorted and the proof fields
 * (signature, issuedAt) removed.
 */
export async function bodyDigest(body: Record<string, unknown>): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "signature" && key !== "issuedAt")
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, inner]) => [key, canonical(inner)]),
      );
    }
    return value;
  };

  const bytes = new TextEncoder().encode(JSON.stringify(canonical(body)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Accepted signatures and their issuedAt. Entries older than the window are
 * swept, since they would be refused anyway.
 */
const consumed = new Map<string, number>();

function consume(signature: string, issuedAt: number, now: number): void {
  for (const [seen, when] of consumed) {
    if (now - when > SIGNATURE_WINDOW_MS) consumed.delete(seen);
  }
  if (consumed.has(signature)) {
    throw new Unauthorized("this signature has already been used; sign again");
  }
  consumed.set(signature, issuedAt);
}

/** Decode a base58 address, reporting a malformed one as a 400 rather than a 500. */
function decodeBase58(value: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array;
  try {
    bytes = sharedDecodeBase58(value);
  } catch {
    throw new BadRequest("wallet is not valid base58");
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

/** Verify that `wallet` signed this action recently. Throws Unauthorized on any failure. */
export async function verifySignedAction(
  signed: SignedAction,
  args: {
    readonly action: string;
    readonly resource: string;
    readonly bodyDigest?: string;
    readonly now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();

  if (!Number.isFinite(signed.issuedAt)) {
    throw new Unauthorized("issuedAt must be a timestamp in milliseconds");
  }
  // Asymmetric: allowing the full window forward would let a future-dated
  // signature live twice as long.
  if (signed.issuedAt - now > CLOCK_SKEW_MS) {
    throw new Unauthorized("issuedAt is in the future; check the client clock");
  }
  if (now - signed.issuedAt > SIGNATURE_WINDOW_MS) {
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
      ...(args.bodyDigest !== undefined ? { bodyDigest: args.bodyDigest } : {}),
    }),
  );

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
  } catch {
    throw new Unauthorized("wallet is not a valid Ed25519 public key");
  }

  const valid = await crypto.subtle.verify("Ed25519", key, signature, message);
  if (!valid) {
    throw new Unauthorized("signature does not match this wallet, action and body");
  }
  // Keyed on the decoded bytes: atob accepts several spellings of one
  // signature (padding stripped, surrounding whitespace), and each would
  // otherwise get its own single-use entry.
  consume(canonicalSignatureKey(signature), signed.issuedAt, now);
}

/** Hex of the signature bytes, so every base64 spelling maps to one key. */
function canonicalSignatureKey(signature: Uint8Array): string {
  let out = "";
  for (const byte of signature) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Whether wallet signatures are enforced. On unless REQUIRE_WALLET_SIGNATURE=0,
 * which is for local development only.
 */
export function signatureRequired(): boolean {
  return process.env["REQUIRE_WALLET_SIGNATURE"] !== "0";
}

/** Verify the signature and issuedAt carried in a request body for this action. */
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
    {
      action: args.action,
      resource: args.resource,
      bodyDigest: await bodyDigest(body),
    },
  );
}
