import { Hono } from "hono";
import { averageHoldSeconds } from "@ps/core";
import { decodeBase58 } from "@ps/chain";
import type { ProfileRow } from "@ps/db";
import type { Services } from "../context.ts";
import { Unauthorized, authorize, signatureRequired } from "../lib/auth.ts";
import { inspectImage } from "../lib/images.ts";
import {
  BadRequest,
  displayLength,
  overstacked,
  readJson,
  requireBase58Address,
  requireInt,
  sanitizeDisplayText,
} from "../lib/validate.ts";

export const SESSION_MS = 30 * 24 * 60 * 60_000;
const MAX_NAME = 32;
const MAX_BIO = 160;
export const MAX_FOLLOWING = 2_000;

/** Handles that would read as the product speaking, or as a word the app uses in its links. */
const RESERVED = new Set([
  "admin",
  "administrator",
  "api",
  "bigsec",
  "baskets",
  "help",
  "jupiter",
  "me",
  "mod",
  "moderator",
  "official",
  "phantom",
  "prestocks",
  "root",
  "solana",
  "solflare",
  "staff",
  "support",
  "system",
  "team",
  "traders",
  // The companies themselves: "@openai" would read as the company speaking.
  "openai",
  "anthropic",
  "spacex",
  "anduril",
  "neuralink",
  "figureai",
  "figure",
  "kalshi",
  "polymarket",
]);

/**
 * Words no username may contain at all, because "bigsec_support" and
 * "prestocks_official" impersonate as well as the bare word does.
 */
const RESERVED_PARTS = ["bigsec", "prestocks", "official", "support", "admin", "moderator"];

const HANDLE = /^[a-z0-9_]{3,20}$/;

export const AVATAR_PRESETS = 9;
export const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_MIN_SIDE = 32;
const AVATAR_MAX_SIDE = 1024;

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The stored session key: a hash of the token and of whether signatures were
 * required, so a token minted with checks off stops working once they are on.
 */
function sessionKey(token: string): Promise<string> {
  return sha256(`${signatureRequired() ? "" : "dev:"}${token}`);
}

/**
 * Digest of the signature that bought a session, so the database can refuse it
 * a second time. Taken over the decoded bytes, since base64 has several
 * spellings of one signature; null when there is no signature.
 */
async function proofOf(signature: unknown): Promise<string | null> {
  if (typeof signature !== "string") return null;
  try {
    const binary = atob(signature.trim());
    let hex = "";
    for (let i = 0; i < binary.length; i++) hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
    return sha256(`sign-in:${hex}`);
  } catch {
    return null;
  }
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isPublicKey(address: string): boolean {
  try {
    return decodeBase58(address).length === 32;
  } catch {
    return false;
  }
}

/**
 * Public fields of a profile; absent ones are empty rather than missing.
 * `avatar` is the picture's token (see Store.avatars), null for the
 * character the wallet's address picks.
 */
function profileDto(wallet: string, row: ProfileRow | null | undefined, avatar: string | null) {
  return {
    wallet,
    name: row?.name ?? "",
    handle: row?.handle ?? null,
    bio: row?.bio ?? "",
    avatar,
    joinedAt: row ? new Date(row.createdAt).toISOString() : null,
  };
}

/**
 * Decode and check an uploaded picture. It arrives as base64 in JSON, so the
 * content-type rule still forces a preflight, and its bytes decide its type
 * (lib/images.ts). The app strips metadata, so a picture carrying it is refused.
 */
function parseAvatarImage(value: unknown): { mime: string; bytes: Uint8Array } {
  if (typeof value !== "string" || value.length === 0) throw new BadRequest("image must be a base64 string");
  if (value.length > Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 4) {
    throw new BadRequest(`a picture must be at most ${MAX_AVATAR_BYTES / 1024}KB`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BadRequest("image is not base64");
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.length > MAX_AVATAR_BYTES) throw new BadRequest(`a picture must be at most ${MAX_AVATAR_BYTES / 1024}KB`);
  const facts = inspectImage(bytes);
  if (!facts) throw new BadRequest("that is not a PNG, JPEG or WebP picture");
  if (facts.metadata) {
    throw new BadRequest("this picture carries camera or location data; choose it again in the app, which removes it");
  }
  const sides = [facts.width, facts.height];
  if (sides.some((side) => side < AVATAR_MIN_SIDE || side > AVATAR_MAX_SIDE)) {
    throw new BadRequest(`a picture must be ${AVATAR_MIN_SIDE} to ${AVATAR_MAX_SIDE} pixels on each side`);
  }
  return { mime: facts.type, bytes };
}

export function parseHandle(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new BadRequest("handle must be a string");
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (handle === "") return null;
  if (!HANDLE.test(handle)) {
    throw new BadRequest("a username is 3 to 20 letters, numbers or underscores");
  }
  if (RESERVED.has(handle) || RESERVED_PARTS.some((part) => handle.includes(part))) {
    throw new BadRequest("that username is reserved");
  }
  return handle;
}

function parseText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new BadRequest(`${field} must be a string`);
  // Sanitised before measuring, and measured in graphemes, so the limit
  // applies to what a reader sees.
  const text = sanitizeDisplayText(value);
  if (displayLength(text) > max) throw new BadRequest(`${field} must be at most ${max} characters`);
  // Stacked accents draw over neighbouring text, and a grapheme count alone
  // would let one character carry hundreds of them.
  if (overstacked(text) || [...text].length > max * 4) {
    throw new BadRequest(`${field} has too many accent marks`);
  }
  return text;
}

export function registerSocialRoutes(app: Hono, services: Services): void {
  const { store } = services;

  /** The wallet a request's token signs in, or a 401 saying to sign in. */
  async function signedIn(body: Record<string, unknown>): Promise<string> {
    const token = body["token"];
    if (typeof token !== "string" || token.length < 20 || token.length > 100) {
      throw new Unauthorized("sign in first");
    }
    const wallet = store.sessionWallet(await sessionKey(token), Date.now());
    if (!wallet) throw new Unauthorized("your sign-in has expired; sign in again");
    return wallet;
  }

  app.post("/api/session", async (c) => {
    const body = await readJson(c);
    const wallet = requireBase58Address(body["wallet"], "wallet");
    await authorize(body, { action: "sign-in", resource: "profile-and-follows", wallet });

    const token = newToken();
    const now = Date.now();
    const expiresAt = now + SESSION_MS;
    const stored = store.createSession(await sessionKey(token), wallet, now, expiresAt, await proofOf(body["signature"]));
    if (stored === "used") throw new Unauthorized("this sign-in has already been used; sign again");
    return c.json({ token, wallet, expiresAt: new Date(expiresAt).toISOString() }, 201);
  });

  app.post("/api/session/end", async (c) => {
    const body = await readJson(c);
    if (typeof body["token"] === "string") store.endSession(await sessionKey(body["token"]));
    return c.json({ ok: true });
  });

  app.get("/api/profiles/:wallet", (c) => {
    const wallet = requireBase58Address(c.req.param("wallet"), "wallet");
    const viewerRaw = c.req.query("viewer");
    const viewer = viewerRaw ? requireBase58Address(viewerRaw, "viewer") : null;

    const summary = store.tradeSummary(wallet);
    const trades = summary.count > 0 ? store.tradesFor(wallet, 2_000) : [];
    const counts = store.followCounts(wallet);

    return c.json({
      ...profileDto(wallet, store.profile(wallet), store.avatar(wallet)),
      followers: counts.followers,
      following: counts.following,
      viewerFollows: viewer && viewer !== wallet ? store.isFollowing(viewer, wallet) : false,
      followsViewer: viewer && viewer !== wallet ? store.isFollowing(wallet, viewer) : false,
      mutuals: viewer && viewer !== wallet ? store.mutualFollowers(viewer, wallet) : 0,
      activity: {
        trades: summary.count,
        firstTradeAt: summary.firstAt === null ? null : new Date(summary.firstAt * 1000).toISOString(),
        lastTradeAt: summary.lastAt === null ? null : new Date(summary.lastAt * 1000).toISOString(),
        avgHoldSeconds: averageHoldSeconds(trades, Math.floor(Date.now() / 1000)),
      },
    });
  });

  app.get("/api/profiles", (c) => {
    const raw = (c.req.query("wallets") ?? "").split(",").map((w) => w.trim()).filter(Boolean);
    if (raw.length > 100) throw new BadRequest("at most 100 wallets at a time");
    const wallets = raw.map((w) => requireBase58Address(w, "wallets"));
    const rows = store.profiles(wallets);
    const avatars = store.avatars(wallets);
    const known = [...new Set([...rows.keys(), ...avatars.keys()])];
    return c.json({
      profiles: Object.fromEntries(
        known.map((wallet) => [
          wallet,
          { name: rows.get(wallet)?.name ?? "", handle: rows.get(wallet)?.handle ?? null, avatar: avatars.get(wallet) ?? null },
        ]),
      ),
    });
  });

  app.get("/api/handles/:handle", (c) => {
    const handle = parseHandle(c.req.param("handle"));
    const row = handle ? store.profileByHandle(handle) : null;
    if (!row) return c.json({ error: "nobody has that username" }, 404);
    return c.json({ wallet: row.wallet, handle: row.handle, avatar: store.avatar(row.wallet) });
  });

  /** Edit the signed-in wallet's profile. The token decides whose, never the body. */
  app.post("/api/profile", async (c) => {
    const body = await readJson(c);
    const wallet = await signedIn(body);
    const name = parseText(body["name"], "name", MAX_NAME);
    const bio = parseText(body["bio"], "bio", MAX_BIO);
    const handle = parseHandle(body["handle"]);

    if (store.writeProfile({ wallet, name, handle, bio, now: Date.now() }) === "taken") {
      return c.json({ error: "that username is taken" }, 409);
    }
    return c.json(profileDto(wallet, store.profile(wallet), store.avatar(wallet)));
  });

  app.post("/api/profile/avatar", async (c) => {
    const body = await readJson(c);
    const wallet = await signedIn(body);
    const asked = [body["preset"] !== undefined, body["image"] !== undefined, body["clear"] === true];
    if (asked.filter(Boolean).length !== 1) throw new BadRequest("send exactly one of preset, image or clear");

    const now = Date.now();
    if (body["clear"] === true) {
      store.clearAvatar(wallet);
    } else if (body["preset"] !== undefined) {
      const preset = body["preset"];
      if (typeof preset !== "number" || !Number.isInteger(preset) || preset < 0 || preset >= AVATAR_PRESETS) {
        throw new BadRequest(`preset must be a whole number from 0 to ${AVATAR_PRESETS - 1}`);
      }
      store.setAvatarPreset(wallet, preset, now);
    } else {
      const image = parseAvatarImage(body["image"]);
      store.setAvatarUpload(wallet, image.mime, image.bytes, now);
    }
    return c.json({ wallet, avatar: store.avatar(wallet) });
  });

  /**
   * A wallet's uploaded picture. With `v` matching the upload time it may be
   * cached forever, since a new upload changes the link; otherwise for a
   * minute. Served as its verified raster type under a sandboxing CSP.
   */
  app.get("/api/avatars/:wallet", (c) => {
    const wallet = requireBase58Address(c.req.param("wallet"), "wallet");
    const image = store.avatarImage(wallet);
    if (!image) return c.json({ error: "this wallet has no picture of its own" }, 404);
    const current = c.req.query("v") === String(image.updatedAt);
    return new Response(image.bytes, {
      headers: {
        "content-type": image.mime,
        "cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=60",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });

  app.post("/api/follows", async (c) => {
    const body = await readJson(c);
    const follower = await signedIn(body);
    const followee = requireBase58Address(body["followee"], "followee");
    if (!isPublicKey(followee)) throw new BadRequest("followee is not a valid Solana address");
    if (typeof body["follow"] !== "boolean") throw new BadRequest("follow must be true or false");
    if (followee === follower) throw new BadRequest("you cannot follow yourself");

    if (body["follow"]) {
      if (!store.isFollowing(follower, followee) && store.followCounts(follower).following >= MAX_FOLLOWING) {
        throw new BadRequest(`you can follow at most ${MAX_FOLLOWING.toLocaleString("en-US")} wallets`);
      }
      store.follow(follower, followee, Date.now());
    } else {
      store.unfollow(follower, followee);
    }
    return c.json({
      following: store.isFollowing(follower, followee),
      followers: store.followCounts(followee).followers,
    });
  });

  for (const side of ["followers", "following"] as const) {
    app.get(`/api/profiles/:wallet/${side}`, (c) => {
      const wallet = requireBase58Address(c.req.param("wallet"), "wallet");
      const limit = requireInt(c.req.query("limit"), "limit", { min: 1, max: 200, fallback: 100 });
      const rows = side === "followers" ? store.followers(wallet, limit) : store.following(wallet, limit);
      const names = store.profiles(rows.map((r) => r.wallet));
      const avatars = store.avatars(rows.map((r) => r.wallet));
      return c.json({
        wallet,
        [side]: rows.map((r) => ({
          wallet: r.wallet,
          name: names.get(r.wallet)?.name ?? "",
          handle: names.get(r.wallet)?.handle ?? null,
          avatar: avatars.get(r.wallet) ?? null,
          since: new Date(r.at).toISOString(),
        })),
      });
    });
  }
}
