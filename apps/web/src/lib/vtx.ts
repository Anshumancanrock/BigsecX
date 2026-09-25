/**
 * Minimal versioned-transaction parsing: enough to split the signatures from
 * the message and check that a wallet returned the transaction it was asked
 * to sign, without shipping web3.js.
 *
 * Wire layout: [compact-u16 signature count][64 bytes per signature][message].
 * compact-u16 (shortvec) carries seven bits per byte, low group first, with
 * the high bit set while more bytes follow.
 */

import { toBase58 } from "./bytes.ts";

export interface SplitTransaction {
  readonly signatureCount: number;
  readonly signatures: Uint8Array;
  readonly message: Uint8Array;
}

function readCompactU16(bytes: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    const byte = bytes[offset + size];
    if (byte === undefined) throw new Error("truncated compact-u16");
    value |= (byte & 0x7f) << (size * 7);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size > 3) throw new Error("compact-u16 too long");
  }
  return { value, size };
}

export function splitTransaction(bytes: Uint8Array): SplitTransaction {
  const { value: signatureCount, size } = readCompactU16(bytes, 0);
  const start = size + signatureCount * 64;
  if (start > bytes.length) throw new Error("transaction is shorter than its signature count claims");
  return {
    signatureCount,
    signatures: bytes.subarray(size, start),
    message: bytes.subarray(start),
  };
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Programs a wallet may add to or change in a transaction it signs: fee settings and its own guard checks. */
const WALLET_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
]);

interface ParsedInstruction {
  readonly program: string;
  readonly key: string;
}

/**
 * Fee payer and instructions of a legacy or v0 message, with every account
 * resolved to its address, or to its lookup table and index, so two messages
 * compare equal even when a wallet reorders or adds keys.
 */
function parseMessage(m: Uint8Array): { feePayer: string; instructions: ParsedInstruction[] } {
  const versioned = (m[0]! & 0x80) !== 0;
  let o = versioned ? 4 : 3;
  const read = () => {
    const { value, size } = readCompactU16(m, o);
    o += size;
    return value;
  };
  const keys: string[] = [];
  for (let i = read(); i > 0; i--, o += 32) keys.push(toBase58(m.subarray(o, o + 32)));
  o += 32;
  const raw: { program: number; accounts: number[]; data: string }[] = [];
  for (let i = read(); i > 0; i--) {
    const program = m[o++]!;
    const count = read();
    const accounts = [...m.subarray(o, o + count)];
    o += count;
    const length = read();
    const data = [...m.subarray(o, o + length)].join(",");
    o += length;
    raw.push({ program, accounts, data });
  }
  const writable: string[] = [];
  const readonly: string[] = [];
  if (versioned) {
    for (let t = read(); t > 0; t--) {
      const table = toBase58(m.subarray(o, o + 32));
      o += 32;
      for (const list of [writable, readonly]) {
        const count = read();
        for (let j = 0; j < count; j++) list.push(`${table}:${m[o + j]}`);
        o += count;
      }
    }
  }
  if (o > m.length) throw new Error("truncated message");
  const all = [...keys, ...writable, ...readonly];
  const at = (index: number) => {
    const key = all[index];
    if (key === undefined) throw new Error("account index out of range");
    return key;
  };
  return {
    feePayer: keys[0] ?? "",
    instructions: raw.map((ix) => ({
      program: at(ix.program),
      key: `${at(ix.program)}|${ix.accounts.map(at).join(",")}|${ix.data}`,
    })),
  };
}

/**
 * Whether a signed message does what the sent one did: the same fee payer and
 * exactly the same instructions, apart from compute-budget and guard
 * instructions that wallets such as OKX and Phantom adjust or add when signing.
 */
export function sameIntent(sent: Uint8Array, signed: Uint8Array): boolean {
  if (sameBytes(sent, signed)) return true;
  try {
    const a = parseMessage(sent);
    const b = parseMessage(signed);
    if (a.feePayer !== b.feePayer) return false;
    const own = (list: ParsedInstruction[]) =>
      list.filter((ix) => !WALLET_PROGRAMS.has(ix.program)).map((ix) => ix.key).sort();
    const x = own(a.instructions);
    const y = own(b.instructions);
    return x.length === y.length && x.every((key, i) => key === y[i]);
  } catch {
    return false;
  }
}
