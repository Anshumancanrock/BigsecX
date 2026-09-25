import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { TestWallet, makeServices } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
function app() {
  const services = makeServices();
  open.push(services.store);
  return { app: createApp(services), store: services.store };
}
afterEach(() => {
  while (open.length) open.pop()?.close();
});

type App = ReturnType<typeof createApp>;

const post = (a: App, path: string, body: unknown) =>
  a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Sign in as a wallet, the way the client does: one signature, one token. */
async function signIn(a: App, wallet: TestWallet): Promise<string> {
  const body = { wallet: wallet.address };
  const res = await post(a, "/api/session", {
    ...body,
    ...(await wallet.sign("sign-in", "profile-and-follows", body)),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

interface ProfileBody {
  wallet: string;
  name: string;
  handle: string | null;
  bio: string;
  joinedAt: string | null;
  followers: number;
  following: number;
  viewerFollows: boolean;
  followsViewer: boolean;
  mutuals: number;
  activity: { trades: number; firstTradeAt: string | null; avgHoldSeconds: number | null };
}

const profileOf = async (a: App, wallet: string, viewer?: string) =>
  (await (await a.request(`/api/profiles/${wallet}${viewer ? `?viewer=${viewer}` : ""}`)).json()) as ProfileBody;

describe("signing in", () => {
  test("a signature from the wallet buys a token", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    expect(token.length).toBeGreaterThan(30);
  });

  test("a signature from another wallet is refused", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const mallory = new TestWallet();
    const body = { wallet: alice.address };
    const res = await post(a, "/api/session", {
      ...body,
      ...(await mallory.sign("sign-in", "profile-and-follows", body)),
    });
    expect(res.status).toBe(401);
  });

  test("a sign-in signature works once", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const body = { wallet: alice.address };
    const proof = { ...body, ...(await alice.sign("sign-in", "profile-and-follows", body)) };
    expect((await post(a, "/api/session", proof)).status).toBe(201);
    expect((await post(a, "/api/session", proof)).status).toBe(401);
  });

  test("a signature for some other action cannot sign in", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const body = { wallet: alice.address };
    const res = await post(a, "/api/session", { ...body, ...(await alice.sign("create-strategy", "new", body)) });
    expect(res.status).toBe(401);
  });

  test("signing out ends the token", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    expect((await post(a, "/api/profile", { token, name: "A" })).status).toBe(200);
    await post(a, "/api/session/end", { token });
    expect((await post(a, "/api/profile", { token, name: "B" })).status).toBe(401);
  });
});

describe("profiles", () => {
  test("a wallet with no profile answers with empty fields and zero counts", async () => {
    const { app: a } = app();
    const body = await profileOf(a, new TestWallet().address);
    expect(body.name).toBe("");
    expect(body.handle).toBeNull();
    expect(body.joinedAt).toBeNull();
    expect(body.followers).toBe(0);
    expect(body.following).toBe(0);
    expect(body.activity.trades).toBe(0);
    expect(body.activity.avgHoldSeconds).toBeNull();
  });

  test("editing needs a token", async () => {
    const { app: a } = app();
    expect((await post(a, "/api/profile", { name: "Nobody" })).status).toBe(401);
    expect((await post(a, "/api/profile", { token: "x".repeat(40), name: "Nobody" })).status).toBe(401);
  });

  test("saves a name, username and bio, and remembers when it was made", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const token = await signIn(a, alice);
    const res = await post(a, "/api/profile", { token, name: "Alice", handle: "@Alice_01", bio: "Long OpenAI." });
    expect(res.status).toBe(200);

    const body = await profileOf(a, alice.address);
    expect(body.name).toBe("Alice");
    // Stored lowercase, without the @.
    expect(body.handle).toBe("alice_01");
    expect(body.bio).toBe("Long OpenAI.");
    expect(body.joinedAt).not.toBeNull();
  });

  test("the token decides whose profile is written, not the body", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const bob = new TestWallet();
    const token = await signIn(a, alice);
    await post(a, "/api/profile", { token, wallet: bob.address, name: "Not Bob" });
    expect((await profileOf(a, bob.address)).name).toBe("");
    expect((await profileOf(a, alice.address)).name).toBe("Not Bob");
  });

  test("invisible characters are removed and length is checked after", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const token = await signIn(a, alice);
    await post(a, "/api/profile", { token, name: "Ali​ce‮" });
    expect((await profileOf(a, alice.address)).name).toBe("Alice");
    expect((await post(a, "/api/profile", { token, name: "x".repeat(33) })).status).toBe(400);
    expect((await post(a, "/api/profile", { token, bio: "x".repeat(161) })).status).toBe(400);
  });

  test("usernames must be well formed and not reserved", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    for (const handle of ["ab", "has space", "dash-es", "x".repeat(21), "émile"]) {
      expect((await post(a, "/api/profile", { token, handle })).status).toBe(400);
    }
    expect((await post(a, "/api/profile", { token, handle: "Bigsec" })).status).toBe(400);
  });

  test("a username belongs to one wallet, whatever its case", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const bob = new TestWallet();
    const aliceToken = await signIn(a, alice);
    const bobToken = await signIn(a, bob);
    expect((await post(a, "/api/profile", { token: aliceToken, handle: "moon" })).status).toBe(200);
    expect((await post(a, "/api/profile", { token: bobToken, handle: "MOON" })).status).toBe(409);
    // Keeping one's own handle is not a clash.
    expect((await post(a, "/api/profile", { token: aliceToken, handle: "moon", bio: "hi" })).status).toBe(200);

    const found = (await (await a.request("/api/handles/Moon")).json()) as { wallet: string };
    expect(found.wallet).toBe(alice.address);
    expect((await a.request("/api/handles/nobody_here")).status).toBe(404);
  });

  test("names for many wallets come back in one call", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const bob = new TestWallet();
    await post(a, "/api/profile", { token: await signIn(a, alice), name: "Alice" });
    const res = await a.request(`/api/profiles?wallets=${alice.address},${bob.address}`);
    const body = (await res.json()) as { profiles: Record<string, { name: string }> };
    expect(body.profiles[alice.address]?.name).toBe("Alice");
    // A wallet without a profile is simply absent.
    expect(body.profiles[bob.address]).toBeUndefined();
  });

  test("activity counts what the index saw", async () => {
    const { app: a, store } = app();
    const alice = new TestWallet();
    const trade = (signature: string, uiAmount: number, valueUsd: number, slot: number, blockTime: number) => ({
      signature,
      owner: alice.address,
      symbol: "OPENAI",
      slot,
      blockTime,
      deltaRaw: 1n,
      uiAmount,
      valueUsd,
    });
    // Bought, then sold two days later: one hold of two days.
    store.writeTrades([trade("s1", 1, 100, 1, 1_000_000), trade("s2", -1, -110, 2, 1_000_000 + 2 * 86_400)]);
    const body = await profileOf(a, alice.address);
    expect(body.activity.trades).toBe(2);
    expect(body.activity.firstTradeAt).toBe(new Date(1_000_000_000).toISOString());
    expect(body.activity.avgHoldSeconds).toBe(2 * 86_400);
  });
});

describe("follows", () => {
  test("following counts on both sides and shows to the viewer", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const bob = new TestWallet();
    const token = await signIn(a, alice);
    const res = await post(a, "/api/follows", { token, followee: bob.address, follow: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ following: true, followers: 1 });

    const bobSeenByAlice = await profileOf(a, bob.address, alice.address);
    expect(bobSeenByAlice.followers).toBe(1);
    expect(bobSeenByAlice.viewerFollows).toBe(true);
    const aliceSeenByBob = await profileOf(a, alice.address, bob.address);
    expect(aliceSeenByBob.following).toBe(1);
    expect(aliceSeenByBob.followsViewer).toBe(true);
  });

  test("following twice is one follow, and unfollowing undoes it", async () => {
    const { app: a } = app();
    const bob = new TestWallet();
    const token = await signIn(a, new TestWallet());
    await post(a, "/api/follows", { token, followee: bob.address, follow: true });
    await post(a, "/api/follows", { token, followee: bob.address, follow: true });
    expect((await profileOf(a, bob.address)).followers).toBe(1);
    const res = await post(a, "/api/follows", { token, followee: bob.address, follow: false });
    expect(await res.json()).toEqual({ following: false, followers: 0 });
  });

  test("nobody follows themselves, or a string that is not a wallet", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const token = await signIn(a, alice);
    expect((await post(a, "/api/follows", { token, followee: alice.address, follow: true })).status).toBe(400);
    // Base58 and the right length, but not a 32-byte key.
    expect((await post(a, "/api/follows", { token, followee: "1".repeat(40), follow: true })).status).toBe(400);
    expect((await post(a, "/api/follows", { token, followee: "nope", follow: true })).status).toBe(400);
    expect((await post(a, "/api/follows", { token, followee: new TestWallet().address })).status).toBe(400);
  });

  test("a follow needs a token", async () => {
    const { app: a } = app();
    const res = await post(a, "/api/follows", { followee: new TestWallet().address, follow: true });
    expect(res.status).toBe(401);
  });

  test("mutuals are the wallets you follow who follow them too", async () => {
    const { app: a } = app();
    const [viewer, carol, dave, target] = [new TestWallet(), new TestWallet(), new TestWallet(), new TestWallet()];
    const viewerToken = await signIn(a, viewer);
    await post(a, "/api/follows", { token: viewerToken, followee: carol.address, follow: true });
    await post(a, "/api/follows", { token: viewerToken, followee: dave.address, follow: true });
    await post(a, "/api/follows", { token: await signIn(a, carol), followee: target.address, follow: true });
    // Someone the viewer does not follow does not count.
    await post(a, "/api/follows", { token: await signIn(a, new TestWallet()), followee: target.address, follow: true });

    const body = await profileOf(a, target.address, viewer.address);
    expect(body.followers).toBe(2);
    expect(body.mutuals).toBe(1);
  });

  test("follow lists carry names, newest first", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const bob = new TestWallet();
    const bobToken = await signIn(a, bob);
    await post(a, "/api/profile", { token: bobToken, name: "Bob", handle: "bobby" });
    await post(a, "/api/follows", { token: bobToken, followee: alice.address, follow: true });

    const followers = (await (await a.request(`/api/profiles/${alice.address}/followers`)).json()) as {
      followers: { wallet: string; name: string; handle: string | null }[];
    };
    expect(followers.followers).toEqual([
      expect.objectContaining({ wallet: bob.address, name: "Bob", handle: "bobby" }),
    ]);
    const following = (await (await a.request(`/api/profiles/${bob.address}/following`)).json()) as {
      following: { wallet: string }[];
    };
    expect(following.following.map((f) => f.wallet)).toEqual([alice.address]);
  });

  test("the feed is what the wallets you follow traded", async () => {
    const { app: a, store } = app();
    const viewer = new TestWallet();
    const followed = new TestWallet();
    const stranger = new TestWallet();
    const trade = (signature: string, owner: string, slot: number) => ({
      signature,
      owner,
      symbol: "OPENAI",
      slot,
      blockTime: 1_789_000_000 + slot,
      deltaRaw: 1n,
      uiAmount: 1,
      valueUsd: 100,
    });
    store.writeTrades([trade("f1", followed.address, 1), trade("s1", stranger.address, 2), trade("f2", followed.address, 3)]);
    const token = await signIn(a, viewer);
    await post(a, "/api/profile", { token: await signIn(a, followed), name: "Followed" });
    await post(a, "/api/follows", { token, followee: followed.address, follow: true });

    const body = (await (await a.request(`/api/feed/${viewer.address}`)).json()) as {
      trades: { signature: string; name: string | null; side: string }[];
    };
    expect(body.trades.map((t) => t.signature)).toEqual(["f2", "f1"]);
    expect(body.trades[0]?.name).toBe("Followed");
    expect(body.trades[0]?.side).toBe("buy");
  });
});

describe("hardening", () => {
  test("usernames that impersonate the product or a company are refused", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    for (const handle of ["bigsec_support", "prestocks_official", "phantom_support", "openai", "SpaceX"]) {
      expect((await post(a, "/api/profile", { token, handle })).status).toBe(400);
    }
    // A fan of a company is not the company.
    expect((await post(a, "/api/profile", { token, handle: "openai_fan" })).status).toBe(200);
  });

  test("a name is measured in characters a reader sees, and cannot stack accents", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const token = await signIn(a, alice);
    // Thirty-two emoji of several code points each fit a 32-character name.
    expect((await post(a, "/api/profile", { token, name: "👩\u200D💻".repeat(32) })).status).toBe(200);
    expect((await post(a, "/api/profile", { token, name: `a${"\u0301".repeat(31)}` })).status).toBe(400);
  });

  test("a spent sign-in cannot be spent again, even by a fresh server", async () => {
    const { store } = app();
    const now = Date.now();
    expect(store.createSession("hash-1", "W", now, now + 60_000, "proof-1")).toBe("ok");
    expect(store.createSession("hash-2", "W", now, now + 60_000, "proof-1")).toBe("used");
  });

  test("a wallet keeps its newest ten sessions", async () => {
    const { store } = app();
    const now = Date.now();
    for (let i = 0; i < 12; i++) store.createSession(`hash-${i}`, "W", now + i, now + 60_000, `proof-${i}`);
    expect(store.sessionCount("W", now)).toBe(10);
    expect(store.sessionWallet("hash-0", now)).toBeNull();
    expect(store.sessionWallet("hash-11", now)).toBe("W");
  });

  test("a session made while signatures were off stops working when they are on", async () => {
    const { app: a } = app();
    const victim = new TestWallet();
    const before = process.env["REQUIRE_WALLET_SIGNATURE"];
    process.env["REQUIRE_WALLET_SIGNATURE"] = "0";
    let token: string;
    try {
      const res = await post(a, "/api/session", { wallet: victim.address });
      expect(res.status).toBe(201);
      token = ((await res.json()) as { token: string }).token;
    } finally {
      if (before === undefined) delete process.env["REQUIRE_WALLET_SIGNATURE"];
      else process.env["REQUIRE_WALLET_SIGNATURE"] = before;
    }
    expect((await post(a, "/api/profile", { token, name: "Not the victim" })).status).toBe(401);
  });
});
