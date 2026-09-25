/**
 * Sign-in for actions that move no money (profile, follows). One signed
 * message returns a 30-day token stored per wallet; transactions are still
 * signed one by one in the wallet. Without storage the session lasts for the page.
 */

import { useEffect, useState } from "react";
import { ApiError, api } from "./api.ts";
import { signedRequest } from "./authed.ts";
import type { Connection } from "./wallet.ts";

const key = (wallet: string) => `bx-session:${wallet}`;
const CHANGED = "bx:session";

interface Stored {
  readonly token: string;
  readonly expiresAt: string;
}

const memory = new Map<string, Stored>();

function read(wallet: string): Stored | null {
  try {
    const raw = localStorage.getItem(key(wallet));
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    // Fall through to what this page remembers.
  }
  return memory.get(wallet) ?? null;
}

function write(wallet: string, value: Stored | null): void {
  if (value) memory.set(wallet, value);
  else memory.delete(wallet);
  try {
    if (value) localStorage.setItem(key(wallet), JSON.stringify(value));
    else localStorage.removeItem(key(wallet));
  } catch {
    // The in-memory copy stands in.
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function sessionToken(wallet: string): string | null {
  const stored = read(wallet);
  if (!stored || typeof stored.token !== "string") return null;
  if (!(Date.parse(stored.expiresAt) > Date.now() + 60_000)) return null;
  return stored.token;
}

export async function signIn(connection: Connection): Promise<string> {
  const session = await signedRequest(
    connection,
    { action: "sign-in", resource: "profile-and-follows" },
    { wallet: connection.address },
    (body) => api.signIn(body),
  );
  write(connection.address, { token: session.token, expiresAt: session.expiresAt });
  return session.token;
}

export async function withSession<T>(connection: Connection, run: (token: string) => Promise<T>): Promise<T> {
  const held = sessionToken(connection.address);
  if (held) {
    try {
      return await run(held);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      write(connection.address, null);
    }
  }
  return run(await signIn(connection));
}

export async function signOut(wallet: string): Promise<void> {
  const token = sessionToken(wallet);
  write(wallet, null);
  if (token) await api.signOut(token).catch(() => undefined);
}

export function useSignedIn(wallet: string | null): boolean {
  const [signed, setSigned] = useState(() => (wallet ? sessionToken(wallet) !== null : false));
  useEffect(() => {
    const check = () => setSigned(wallet ? sessionToken(wallet) !== null : false);
    check();
    window.addEventListener(CHANGED, check);
    window.addEventListener("storage", check);
    return () => {
      window.removeEventListener(CHANGED, check);
      window.removeEventListener("storage", check);
    };
  }, [wallet]);
  return signed;
}

export function signInError(error: unknown, verb: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancel/i.test(message)) return `Not signed, so nothing changed.`;
  if (error instanceof ApiError && error.status === 429) return "Too many requests just now. Try again in a moment.";
  if (/cannot sign messages/i.test(message)) return "This wallet cannot sign messages, so it cannot sign in here.";
  return `Could not ${verb}: ${message}`;
}
