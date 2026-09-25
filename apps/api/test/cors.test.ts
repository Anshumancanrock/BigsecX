import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { makeServices } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
  delete process.env["ALLOWED_ORIGINS"];
});

function app() {
  const services = makeServices();
  open.push(services.store);
  return createApp(services);
}

const preflight = (a: ReturnType<typeof createApp>, origin: string) =>
  a.request("/api/submit", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  });

describe("cross-origin policy", () => {
  test("open when no allow-list is configured, which is the local default", async () => {
    const res = await preflight(app(), "https://anywhere.example");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("a configured deployment admits only its own origins", async () => {
    process.env["ALLOWED_ORIGINS"] = "https://basketx.app, https://www.basketx.app";
    const a = app();

    const mine = await preflight(a, "https://basketx.app");
    expect(mine.headers.get("access-control-allow-origin")).toBe("https://basketx.app");

    const second = await preflight(a, "https://www.basketx.app");
    expect(second.headers.get("access-control-allow-origin")).toBe("https://www.basketx.app");

    // The point of the allow-list: another site must not be able to drive
    // the build and submit routes from its visitors' browsers.
    const other = await preflight(a, "https://evil.example");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the allow-list is read fresh per app, so it is never baked at import", async () => {
    process.env["ALLOWED_ORIGINS"] = "https://one.example";
    expect((await preflight(app(), "https://two.example")).headers.get("access-control-allow-origin")).toBeNull();
    process.env["ALLOWED_ORIGINS"] = "https://two.example";
    expect((await preflight(app(), "https://two.example")).headers.get("access-control-allow-origin")).toBe(
      "https://two.example",
    );
  });
});
