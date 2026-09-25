/**
 * Minimal versioned-transaction parsing: enough to split the signatures from
 * the message and check that a wallet returned the transaction it was asked
 * to sign, without shipping web3.js.
 *
 * Wire layout: [compact-u16 signature count][64 bytes per signature][message].
 * compact-u16 (shortvec) carries seven bits per byte, low group first, with
 * the high bit set while more bytes follow.
 */

export interface SplitTransaction {
  readonly signatureCount: number;
  readonly signatures: Uint8Array;
  /** Everything a signature actually signs. */
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
  // Not constant time, and it does not need to be: both sides are public
  // and the comparison decides whether to submit, not whether to trust.
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
