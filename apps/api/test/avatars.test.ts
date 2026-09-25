import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { AVATAR_PRESETS, MAX_AVATAR_BYTES } from "../src/routes/social.ts";
import { TestWallet, makeServices } from "./fakes.ts";
import * as fixture from "./image-fixtures.ts";
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

async function signIn(a: App, wallet: TestWallet): Promise<string> {
  const body = { wallet: wallet.address };
  const res = await post(a, "/api/session", { ...body, ...(await wallet.sign("sign-in", "profile-and-follows", body)) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

const setAvatar = (a: App, body: Record<string, unknown>) => post(a, "/api/profile/avatar", body);
const avatarOf = async (a: App, wallet: string) =>
  ((await (await a.request(`/api/profiles/${wallet}`)).json()) as { avatar: string | null }).avatar;

describe("a wallet's picture", () => {
  test("is null until the wallet chooses one", async () => {
    const { app: a } = app();
    expect(await avatarOf(a, new TestWallet().address)).toBeNull();
  });

  test("can be one of the drawn characters", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const token = await signIn(a, alice);
    const res = await setAvatar(a, { token, preset: 4 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { avatar: string }).avatar).toBe("p4");
    expect(await avatarOf(a, alice.address)).toBe("p4");
  });

  test("refuses a character that does not exist", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    for (const preset of [-1, AVATAR_PRESETS, 1.5, "2", null]) {
      expect((await setAvatar(a, { token, preset })).status).toBe(400);
    }
  });

  test("can be a picture of its own, served back byte for byte as the type its bytes prove", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const token = await signIn(a, alice);
    const res = await setAvatar(a, { token, image: fixture.webpLossy });
    expect(res.status).toBe(200);
    const avatar = ((await res.json()) as { avatar: string }).avatar;
    expect(avatar).toMatch(/^u\d+$/);

    const image = await a.request(`/api/avatars/${alice.address}?v=${avatar.slice(1)}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    // The version in the link makes it safe to keep forever.
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe(fixture.webpLossy);

    // Without the version it is kept for a minute only.
    const bare = await a.request(`/api/avatars/${alice.address}`);
    expect(bare.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("gets a new link with every upload, so a browser never shows the old one", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    const first = ((await (await setAvatar(a, { token, image: fixture.png })).json()) as { avatar: string }).avatar;
    const second = ((await (await setAvatar(a, { token, image: fixture.jpeg })).json()) as { avatar: string }).avatar;
    expect(second).not.toBe(first);
  });

  test("refuses anything that is not a PNG, JPEG or WebP picture, whatever it is called", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    for (const image of [svg, fixture.gif, "not base64!", "", 42]) {
      expect((await setAvatar(a, { token, image })).status).toBe(400);
    }
  });

  test("refuses a picture carrying camera or location data", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    for (const image of [fixture.jpegExif, fixture.webpExif, fixture.pngText]) {
      const res = await setAvatar(a, { token, image });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("location");
    }
  });

  test("refuses a picture out of proportion or too large", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    expect((await setAvatar(a, { token, image: fixture.pngHuge })).status).toBe(400);
    const big = Buffer.alloc(MAX_AVATAR_BYTES + 10, 1).toString("base64");
    expect((await setAvatar(a, { token, image: big })).status).toBe(400);
  });

  test("can go back to the character the address picks", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const token = await signIn(a, alice);
    await setAvatar(a, { token, image: fixture.png });
    const res = await setAvatar(a, { token, clear: true });
    expect(((await res.json()) as { avatar: null }).avatar).toBeNull();
    expect(await avatarOf(a, alice.address)).toBeNull();
    expect((await a.request(`/api/avatars/${alice.address}`)).status).toBe(404);
  });

  test("a character leaves no picture behind to serve", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const token = await signIn(a, alice);
    await setAvatar(a, { token, image: fixture.png });
    await setAvatar(a, { token, preset: 2 });
    expect((await a.request(`/api/avatars/${alice.address}`)).status).toBe(404);
  });

  test("is written only with the wallet's own sign-in", async () => {
    const { app: a } = app();
    expect((await setAvatar(a, { preset: 1 })).status).toBe(401);
    expect((await setAvatar(a, { token: "x".repeat(40), preset: 1 })).status).toBe(401);
    // A token names its own wallet; the body cannot name another.
    const alice = new TestWallet();
    const bob = new TestWallet();
    const token = await signIn(a, alice);
    await setAvatar(a, { token, preset: 3, wallet: bob.address });
    expect(await avatarOf(a, bob.address)).toBeNull();
    expect(await avatarOf(a, alice.address)).toBe("p3");
  });

  test("takes exactly one choice at a time", async () => {
    const { app: a } = app();
    const token = await signIn(a, new TestWallet());
    expect((await setAvatar(a, { token })).status).toBe(400);
    expect((await setAvatar(a, { token, preset: 1, image: fixture.png })).status).toBe(400);
    expect((await setAvatar(a, { token, preset: 1, clear: true })).status).toBe(400);
  });

  test("travels with the lists that show people", async () => {
    const { app: a } = app();
    const alice = new TestWallet();
    const bob = new TestWallet();
    const aliceToken = await signIn(a, alice);
    const bobToken = await signIn(a, bob);
    await setAvatar(a, { token: aliceToken, preset: 7 });
    await post(a, "/api/follows", { token: bobToken, followee: alice.address, follow: true });

    const following = (await (await a.request(`/api/profiles/${bob.address}/following`)).json()) as {
      following: { wallet: string; avatar: string | null }[];
    };
    expect(following.following).toEqual([expect.objectContaining({ wallet: alice.address, avatar: "p7" })]);

    // A wallet with a picture and no name is still listed.
    const batch = (await (await a.request(`/api/profiles?wallets=${alice.address},${bob.address}`)).json()) as {
      profiles: Record<string, { avatar: string | null }>;
    };
    expect(batch.profiles[alice.address]?.avatar).toBe("p7");
    expect(batch.profiles[bob.address]).toBeUndefined();
  });
});
