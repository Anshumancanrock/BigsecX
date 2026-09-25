/**
 * Identifies an uploaded picture from its own bytes: PNG, JPEG or WebP only
 * (never SVG, which can carry script), with its size and whether it carries
 * camera or location metadata. Every read is bounds-checked.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageFacts {
  readonly type: ImageType;
  readonly width: number;
  readonly height: number;
  readonly metadata: boolean;
}

export function inspectImage(bytes: Uint8Array): ImageFacts | null {
  try {
    if (startsWith(bytes, PNG_SIGNATURE)) return png(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webp(bytes);
  } catch {
    // A read past the end of a malformed file.
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_TEXT = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);

function png(b: Uint8Array): ImageFacts | null {
  let offset = 8;
  let width = 0;
  let height = 0;
  let metadata = false;
  let first = true;
  while (offset + 12 <= b.length) {
    const length = u32be(b, offset);
    const type = ascii(b, offset + 4, 4);
    const data = offset + 8;
    const next = data + length + 4;
    if (next > b.length) return null;
    if (first) {
      if (type !== "IHDR" || length < 8) return null;
      width = u32be(b, data);
      height = u32be(b, data + 4);
      first = false;
    }
    if (PNG_TEXT.has(type)) metadata = true;
    if (type === "IEND") return width && height ? { type: "image/png", width, height, metadata } : null;
    offset = next;
  }
  return null;
}

function jpeg(b: Uint8Array): ImageFacts | null {
  if (b.length < 4 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  let offset = 2;
  let width = 0;
  let height = 0;
  let metadata = false;
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) return null;
    let marker = b[offset + 1]!;
    while (marker === 0xff) {
      offset++;
      if (offset + 1 >= b.length) return null;
      marker = b[offset + 1]!;
    }
    offset += 2;
    if (marker === 0xd9) return null;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;

    if (offset + 2 > b.length) return null;
    const length = u16be(b, offset);
    if (length < 2 || offset + length > b.length) return null;
    const segment = offset + 2;

    if (marker === 0xe1) {
      const tag = ascii(b, segment, Math.min(20, length - 2));
      if (tag.startsWith("Exif") || tag.startsWith("http://ns.adobe.com")) metadata = true;
    }
    if (marker === 0xed) metadata = true;

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7) return null;
      height = u16be(b, segment + 1);
      width = u16be(b, segment + 3);
    }
    if (marker === 0xda) {
      return width && height ? { type: "image/jpeg", width, height, metadata } : null;
    }
    offset += length;
  }
  return null;
}

function webp(b: Uint8Array): ImageFacts | null {
  const end = u32le(b, 4) + 8;
  if (end > b.length || end < 20) return null;
  let offset = 12;
  let width = 0;
  let height = 0;
  let metadata = false;
  let first = true;
  while (offset + 8 <= end) {
    const fourcc = ascii(b, offset, 4);
    const size = u32le(b, offset + 4);
    const data = offset + 8;
    if (data + size > end) return null;
    if (first) {
      first = false;
      if (fourcc === "VP8 ") {
        if (size < 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null;
        width = u16le(b, data + 6) & 0x3fff;
        height = u16le(b, data + 8) & 0x3fff;
      } else if (fourcc === "VP8L") {
        if (size < 5 || b[data] !== 0x2f) return null;
        const bits = u32le(b, data + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (fourcc === "VP8X") {
        if (size < 10) return null;
        width = u24le(b, data + 4) + 1;
        height = u24le(b, data + 7) + 1;
      } else {
        return null;
      }
    }
    if (fourcc === "EXIF" || fourcc === "XMP ") metadata = true;
    offset = data + size + (size % 2);
  }
  return width && height ? { type: "image/webp", width, height, metadata } : null;
}

function startsWith(b: Uint8Array, prefix: readonly number[]): boolean {
  return b.length >= prefix.length && prefix.every((byte, i) => b[i] === byte);
}

function ascii(b: Uint8Array, at: number, length: number): string {
  if (at < 0 || at + length > b.length) throw new RangeError("read past the end");
  return String.fromCharCode(...b.subarray(at, at + length));
}

function byte(b: Uint8Array, at: number): number {
  const value = b[at];
  if (value === undefined) throw new RangeError("read past the end");
  return value;
}

function u16be(b: Uint8Array, at: number): number {
  return (byte(b, at) << 8) | byte(b, at + 1);
}

function u16le(b: Uint8Array, at: number): number {
  return byte(b, at) | (byte(b, at + 1) << 8);
}

function u24le(b: Uint8Array, at: number): number {
  return byte(b, at) | (byte(b, at + 1) << 8) | (byte(b, at + 2) << 16);
}

function u32be(b: Uint8Array, at: number): number {
  return ((byte(b, at) << 24) >>> 0) + ((byte(b, at + 1) << 16) | (byte(b, at + 2) << 8) | byte(b, at + 3));
}

function u32le(b: Uint8Array, at: number): number {
  return (byte(b, at) | (byte(b, at + 1) << 8) | (byte(b, at + 2) << 16)) + byte(b, at + 3) * 0x1000000;
}
