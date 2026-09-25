/**
 * Base58, the encoding Solana uses for addresses and signatures. Written out
 * because it runs in the API, the indexer and the browser bundle, where a
 * CommonJS dependency would break. BigInt is slower than a byte carry loop,
 * which does not matter for inputs of at most 64 bytes.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Index by character code, so decoding does not do a linear scan per digit. */
const VALUES = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }

  // Each leading zero byte encodes as a leading '1'; the loop above drops them
  // because they add nothing to the integer.
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function decodeBase58(value: string): Uint8Array {
  let big = 0n;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const digit = code < 128 ? VALUES[code]! : -1;
    if (digit < 0) throw new Error(`not valid base58 at index ${i}`);
    big = big * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (big > 0n) {
    bytes.unshift(Number(big % 256n));
    big /= 256n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }

  return Uint8Array.from(bytes);
}

/** True when `value` decodes to exactly 32 bytes, the size of an address. */
export function isBase58Address(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}
