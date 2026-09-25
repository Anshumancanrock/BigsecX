import { describe, expect, test } from "bun:test";
import { displayLength, overstacked, sanitizeDisplayText } from "../src/lib/validate.ts";

describe("display text sanitiser", () => {
  test("strips bidi overrides, which make a name render as something else", () => {
    expect(sanitizeDisplayText("Safe‮tekcab")).toBe("Safetekcab");
    for (const ch of ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩", "‎", "‏"]) {
      expect(sanitizeDisplayText(`a${ch}b`)).toBe("ab");
    }
  });

  test("strips zero-width characters, which are pure impersonation", () => {
    expect(sanitizeDisplayText("Ver​ified Index")).toBe("Verified Index");
    for (const ch of ["​", "‌", "‍", "﻿"]) {
      expect(sanitizeDisplayText(`a${ch}b`)).toBe("ab");
    }
  });

  test("flattens newlines and control characters", () => {
    expect(sanitizeDisplayText("Line one\nLine two")).toBe("Line one Line two");
    expect(sanitizeDisplayText("Null\u0000byte")).toBe("Null byte");
    expect(sanitizeDisplayText("Bell\u0007x")).toBe("Bell x");
    expect(sanitizeDisplayText("Tab\there")).toBe("Tab here");
  });

  test("collapses exotic whitespace so padding cannot fake alignment", () => {
    expect(sanitizeDisplayText("a  　b")).toBe("a b");
    expect(sanitizeDisplayText("   spaced   out   ")).toBe("spaced out");
  });

  test("normalises to NFC so one glyph has one representation", () => {
    expect(sanitizeDisplayText("é")).toBe("é");
    expect(sanitizeDisplayText("é")).toBe(sanitizeDisplayText("é"));
  });

  test("a name of nothing but zero-width characters collapses to empty", () => {
    // Which is what makes sanitising BEFORE the length check matter: sixty
    // of these would otherwise pass validation and render as blank.
    expect(sanitizeDisplayText("​".repeat(60))).toBe("");
    expect(sanitizeDisplayText("‮​\u0000  ")).toBe("");
  });

  test("leaves ordinary names, punctuation and non-Latin scripts alone", () => {
    for (const name of ["Frontier AI Labs", "The Mag 7", "AI & Robotics", "Prédiction", "人工知能", "80/20 split"]) {
      expect(sanitizeDisplayText(name)).toBe(name);
    }
  });

  test("does not try to strip markup, which React escapes anyway", () => {
    // Removing "<" would mangle legitimate names for no security gain.
    expect(sanitizeDisplayText("<img src=x>")).toBe("<img src=x>");
  });

  test("strips the other characters that draw nothing", () => {
    for (const ch of ["\u061C", "\u00AD", "\u2060", "\u180E", "\u3164", "\u2800", "\u{E0041}"]) {
      expect(sanitizeDisplayText(`a${ch}b`)).toBe("ab");
    }
    // A name that was only a Hangul filler renders as nothing, so it is nothing.
    expect(sanitizeDisplayText("\u3164")).toBe("");
  });

  test("keeps the joiner inside an emoji, where it is what joins it", () => {
    expect(sanitizeDisplayText("👩\u200D💻 dev")).toBe("👩\u200D💻 dev");
    expect(sanitizeDisplayText("👩🏽\u200D💻")).toBe("👩🏽\u200D💻");
    expect(sanitizeDisplayText("a\u200Db")).toBe("ab");
  });
});

describe("measuring display text", () => {
  test("counts what a reader sees", () => {
    expect(displayLength("👩\u200D💻")).toBe(1);
    expect(displayLength("é")).toBe(1);
    expect(displayLength("abc")).toBe(3);
  });

  test("spots a character carrying a pile of accents", () => {
    expect(overstacked(`a${"\u0301".repeat(31)}`)).toBe(true);
    expect(overstacked("Prédiction")).toBe(false);
    expect(overstacked("👍🏽")).toBe(false);
  });
});
