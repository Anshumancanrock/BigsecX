import { describe, expect, test } from "bun:test";
import { inspectImage } from "../src/lib/images.ts";
import * as fixture from "./image-fixtures.ts";

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

describe("inspectImage", () => {
  test("reads each accepted format's type and size", () => {
    expect(inspectImage(bytes(fixture.png))).toEqual({ type: "image/png", width: 64, height: 48, metadata: false });
    expect(inspectImage(bytes(fixture.jpeg))).toEqual({ type: "image/jpeg", width: 80, height: 60, metadata: false });
    expect(inspectImage(bytes(fixture.jpegProgressive))).toEqual({
      type: "image/jpeg",
      width: 80,
      height: 60,
      metadata: false,
    });
    expect(inspectImage(bytes(fixture.webpLossy))).toEqual({ type: "image/webp", width: 96, height: 72, metadata: false });
    expect(inspectImage(bytes(fixture.webpLossless))).toEqual({
      type: "image/webp",
      width: 96,
      height: 72,
      metadata: false,
    });
  });

  test("notices the data a camera writes, in every format", () => {
    expect(inspectImage(bytes(fixture.jpegExif))?.metadata).toBe(true);
    expect(inspectImage(bytes(fixture.webpExif))?.metadata).toBe(true);
    expect(inspectImage(bytes(fixture.pngText))?.metadata).toBe(true);
  });

  test("reads the size of a picture far too wide, so the route can refuse it", () => {
    expect(inspectImage(bytes(fixture.pngHuge))).toMatchObject({ width: 4000, height: 20 });
  });

  test("refuses anything that is not one of the three", () => {
    expect(inspectImage(bytes(fixture.gif))).toBeNull();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(inspectImage(svg)).toBeNull();
    expect(inspectImage(new TextEncoder().encode("<html><body>hi</body></html>"))).toBeNull();
    expect(inspectImage(new Uint8Array())).toBeNull();
  });

  test("refuses a picture cut short, in every format", () => {
    for (const name of ["png", "jpeg", "webpLossy", "webpLossless"] as const) {
      const whole = bytes(fixture[name]);
      for (const keep of [4, 12, 20, Math.floor(whole.length / 2)]) {
        expect(inspectImage(whole.subarray(0, keep))).toBeNull();
      }
    }
  });

  test("refuses a header whose lengths point past the end", () => {
    const broken = bytes(fixture.png);
    // The first chunk's length, made enormous.
    broken[8] = 0x7f;
    expect(inspectImage(broken)).toBeNull();
    const riff = bytes(fixture.webpLossy);
    // The RIFF size, larger than the file.
    riff[7] = 0x7f;
    expect(inspectImage(riff)).toBeNull();
  });
});
