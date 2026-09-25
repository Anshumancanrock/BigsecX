import { describe, expect, test } from "bun:test";
import { UNIVERSE } from "@ps/core";
import { parseDirectory } from "../src/lib/meta.ts";
import { intradayTable } from "../src/routes/history.ts";

const openai = UNIVERSE.find((t) => t.symbol === "OPENAI")!;

describe("token directory", () => {
  test("reads the logo, holders, and bought-plus-sold volume per company", () => {
    const facts = parseDirectory([
      {
        id: openai.mint,
        icon: "https://www.prestocks.com/logos/openai.png",
        holderCount: 32_130,
        tags: ["verified", "pre-ipo"],
        stats24h: { buyVolume: 1_000, sellVolume: 500, numTraders: 42 },
      },
    ]);
    expect(facts.get("OPENAI")).toEqual({
      iconUrl: "https://www.prestocks.com/logos/openai.png",
      holders: 32_130,
      volume24hUsd: 1_500,
      traders24h: 42,
      verified: true,
    });
    // A mint missing from the directory is absent from the result.
    expect(facts.has("SPACEX")).toBe(false);
  });

  test("passes on only an https logo", () => {
    for (const icon of ["javascript:alert(1)", "http://example.com/x.png", "data:image/png;base64,AAAA", 7]) {
      const facts = parseDirectory([{ id: openai.mint, icon: icon as string }]);
      expect(facts.get("OPENAI")?.iconUrl).toBeNull();
    }
  });
});

describe("hourly table", () => {
  const snapshot = (unixSeconds: number, marketUsd: number | null, multiplier = 1) =>
    ({
      unixSeconds,
      tokens: [{ token: { symbol: "OPENAI" }, marketUsd, multiplier }],
    }) as unknown as Parameters<typeof intradayTable>[1];

  test("aligns to the hour, carries a quiet hour forward, and ends on the live price", () => {
    const now = 10 * 3600 + 1200; // twenty minutes past the tenth hour
    const closes = { OPENAI: { [8 * 3600]: 100, [10 * 3600]: 110 } };
    const table = intradayTable(closes, snapshot(now, 115), 3);
    expect(table.times).toEqual([8 * 3600, 9 * 3600, 10 * 3600, now]);
    // Hour nine had no trade: nothing moved, so it keeps hour eight's price.
    expect(table.prices["OPENAI"]).toEqual([100, 100, 110, 115]);
  });

  test("divides raw closes by the multiplier, as the daily table does", () => {
    const now = 5 * 3600;
    const table = intradayTable({ OPENAI: { [4 * 3600]: 500, [5 * 3600]: 500 } }, snapshot(now, null, 5), 2);
    expect(table.prices["OPENAI"]).toEqual([100, 100]);
  });

  test("a company with no hourly data is all nulls rather than a flat invented line", () => {
    const table = intradayTable({}, snapshot(3 * 3600, 120), 2);
    expect(table.prices["OPENAI"]!.slice(0, -1).every((v) => v === null)).toBe(true);
  });
});
