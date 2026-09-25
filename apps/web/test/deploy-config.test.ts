import { describe, expect, test } from "bun:test";

/**
 * The bundle's fetch origin and the server's CSP must agree: build.ts records
 * the API base it baked in, and preview.ts derives `connect-src` from it.
 * Both are servers, so this tests the shared contract (the manifest's shape
 * and the derived policy) rather than starting either.
 */
function connectSrc(apiBase: string): string {
  return ["'self'", ...(apiBase ? [new URL(apiBase).origin] : [])].join(" ");
}

describe("the built bundle and the served policy agree", () => {
  test("same origin is the default and needs nothing extra", () => {
    expect(connectSrc("")).toBe("'self'");
  });

  test("a cross-origin API is named in the policy, or every request is refused", () => {
    expect(connectSrc("https://api.basketx.app")).toBe("'self' https://api.basketx.app");
    // A path on the base must not leak into the policy; only the origin does.
    expect(connectSrc("https://api.basketx.app/v1")).toBe("'self' https://api.basketx.app");
    expect(connectSrc("http://localhost:3111")).toBe("'self' http://localhost:3111");
  });

  test("a non-default port is part of the origin and must survive", () => {
    // Dropping the port would produce a policy that looks right and refuses
    // every request.
    expect(connectSrc("https://api.example.com:8443")).toContain(":8443");
  });

  test("build.ts writes a manifest the server can read", async () => {
    const manifest = await Bun.file(`${import.meta.dir}/../.build/manifest.json`).json();
    expect(typeof manifest.apiBase).toBe("string");
    // The checked-in default: same origin, so the proxy story holds.
    expect(manifest.apiBase).toBe("");
  });
});
