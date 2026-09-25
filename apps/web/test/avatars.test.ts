import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CHARACTERS, avatarSrc, characterSrc, defaultCharacter, isUpload, presetOf } from "../src/lib/avatars.ts";

const PUBLIC = new URL("../public", import.meta.url).pathname;
const WALLETS = [
  "3D9BjV8aATY6PPMX4BBu9Qxh9uAo8tM27212Mvyc3yJQ",
  "D2RQKjXw54qWze94Dt1CzSKJJSAQnKG3w4UPMoDjQ19x",
  "5BKZBhA7m6hRjxvW9Y8rT2JqzZkq2yQ6YcDvD1dBvD",
  "H4xhTq8fR2jV1qpZs3YgR7wQ8fRmN5bK2cLdE9sT4uV",
];

describe("drawn characters", () => {
  test("there are nine, each a file the site serves", () => {
    expect(CHARACTERS).toHaveLength(9);
    for (let i = 0; i < CHARACTERS.length; i++) expect(existsSync(`${PUBLIC}${characterSrc(i)}`)).toBe(true);
  });

  test("a wallet gets the same character every time, and one of the nine", () => {
    for (const wallet of WALLETS) {
      const pick = defaultCharacter(wallet);
      expect(pick).toBe(defaultCharacter(wallet));
      expect(pick).toBeGreaterThanOrEqual(0);
      expect(pick).toBeLessThan(CHARACTERS.length);
    }
  });

  test("addresses spread across all nine", () => {
    // A thousand made-up addresses should land on every character.
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(defaultCharacter(`Wallet${i}xZ${i * 7919}`));
    expect(seen.size).toBe(CHARACTERS.length);
  });
});

describe("avatar tokens", () => {
  const wallet = WALLETS[0]!;

  test("null is the character the address picks", () => {
    expect(avatarSrc(wallet, null)).toBe(characterSrc(defaultCharacter(wallet)));
    expect(avatarSrc(wallet, undefined)).toBe(characterSrc(defaultCharacter(wallet)));
  });

  test("p and a number is that character", () => {
    expect(presetOf("p0")).toBe(0);
    expect(presetOf("p8")).toBe(8);
    expect(avatarSrc(wallet, "p4")).toBe("/avatars/elm.svg");
  });

  test("u and a time is the wallet's own picture, at a link that changes with it", () => {
    expect(isUpload("u1790348505595")).toBe(true);
    expect(avatarSrc(wallet, "u1790348505595")).toMatch(new RegExp(`/api/avatars/${wallet}\\?v=1790348505595$`));
  });

  test("anything else is the default character, never a broken image", () => {
    for (const token of ["p9", "p-1", "px", "u", "uabc", "http://evil.example/x.png", "p1; drop"]) {
      expect(avatarSrc(wallet, token)).toBe(characterSrc(defaultCharacter(wallet)));
    }
  });
});
