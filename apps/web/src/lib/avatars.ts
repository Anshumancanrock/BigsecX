/**
 * Wallet pictures. The API stores a short token per wallet: "pN" for
 * character N, "u<version>" for an upload, or null for the default, which is
 * picked from the address so it is stable across devices. The characters are
 * files in public/avatars and the server refers to them by index, so only
 * append to the list.
 */

import { useSyncExternalStore } from "react";
import { avatarImageUrl } from "./base.ts";

export const CHARACTERS = [
  { id: "aster", name: "Aster" },
  { id: "basil", name: "Basil" },
  { id: "acorn", name: "Acorn" },
  { id: "rex", name: "Rex" },
  { id: "elm", name: "Elm" },
  { id: "saffron", name: "Saffron" },
  { id: "pip", name: "Pip" },
  { id: "indigo", name: "Indigo" },
  { id: "kiwi", name: "Kiwi" },
] as const;

/** The character a wallet wears until it chooses: the same one every time. */
export function defaultCharacter(wallet: string): number {
  // FNV-1a: cheap, and it spreads addresses that share a prefix.
  let hash = 2166136261;
  for (let i = 0; i < wallet.length; i++) {
    hash ^= wallet.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % CHARACTERS.length;
}

export function characterSrc(index: number): string {
  return `/avatars/${CHARACTERS[index]?.id ?? CHARACTERS[0].id}.svg`;
}

/** The character a token names, or null when it names none. */
export function presetOf(token: string | null | undefined): number | null {
  if (!token || !/^p\d{1,2}$/.test(token)) return null;
  const index = Number(token.slice(1));
  return index < CHARACTERS.length ? index : null;
}

export function isUpload(token: string | null | undefined): token is string {
  return typeof token === "string" && /^u\d{1,16}$/.test(token);
}

/** Where a wallet's picture is. Anything unrecognised is the default character. */
export function avatarSrc(wallet: string, token: string | null | undefined): string {
  if (isUpload(token)) return avatarImageUrl(wallet, token.slice(1));
  return characterSrc(presetOf(token) ?? defaultCharacter(wallet));
}

/*
 * Pictures this page knows more recently than the responses it holds: the
 * connected wallet's own, read on connect and updated on change. Faces check
 * this first, so every instance updates together when the picture changes.
 */
const known = new Map<string, string | null>();
const listeners = new Set<() => void>();

export function rememberAvatar(wallet: string, token: string | null): void {
  if (known.has(wallet) && known.get(wallet) === token) return;
  known.set(wallet, token);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The picture this page knows for a wallet: a token, null for the default, undefined if it knows nothing. */
export function useKnownAvatar(wallet: string): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => known.get(wallet),
    () => undefined,
  );
}

/* ------------------------------------------------------------- faces */

/** Hues from an address, so one wallet always gets the same colours. */
export function hues(address: string): [number, number, number] {
  let hash = 0;
  for (const ch of address) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const a = hash % 360;
  const b = (a + 40 + ((hash >> 9) % 100)) % 360;
  const c = (a + 180 + ((hash >> 17) % 60)) % 360;
  return [a, b, c];
}
