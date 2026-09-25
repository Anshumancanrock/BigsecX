import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BasketCover, COVERS, coverFor } from "../src/features/baskets/BasketCover.tsx";

const PUBLIC = new URL("../public/covers/", import.meta.url).pathname;

describe("basket covers", () => {
  test("every ready-made basket has a photograph of its own, at both sizes", () => {
    for (const id of COVERS) {
      expect(coverFor(id, [])).toBe(id);
      expect(existsSync(`${PUBLIC}${id}-720.webp`)).toBe(true);
      expect(existsSync(`${PUBLIC}${id}-1200.webp`)).toBe(true);
    }
    expect(new Set(COVERS).size).toBe(7);
  });

  test("a basket somebody built wears the cover of what it holds most of", () => {
    const robots = [
      { symbol: "OPENAI", weight: 0.2 },
      { symbol: "FIGUREAI", weight: 0.5 },
      { symbol: "NEURALINK", weight: 0.3 },
    ];
    expect(coverFor("s_4f2a9", robots)).toBe("embodied");
    expect(coverFor("s_4f2a9", [{ symbol: "KALSHI", weight: 1 }])).toBe("prediction");
    expect(coverFor("s_4f2a9", [{ symbol: "SPACEX", weight: 1 }])).toBe("defense-space");
  });

  test("falls back to the whole market for a basket with nothing it can place", () => {
    expect(coverFor("s_empty", null)).toBe("pre8");
    expect(coverFor("s_other", [{ symbol: "UNKNOWN", weight: 1 }])).toBe("pre8");
  });

  test("offers the browser both widths and loads lazily unless asked not to", () => {
    const lazy = renderToStaticMarkup(<BasketCover id="liquid" weights={null} />);
    expect(lazy).toContain('src="/covers/liquid-720.webp"');
    expect(lazy).toContain("/covers/liquid-1200.webp 1200w");
    expect(lazy).toContain('loading="lazy"');
    expect(lazy).toContain('alt=""');
    expect(renderToStaticMarkup(<BasketCover id="liquid" weights={null} eager />)).toContain('loading="eager"');
  });
});
