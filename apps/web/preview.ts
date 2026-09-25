import { file } from "bun";

const ROOT = new URL(".", import.meta.url).pathname;
const OUT = `${ROOT}.build`;
const PORT = Number(process.env["PORT"] ?? 4000);
const API = process.env["API_ORIGIN"] ?? "http://localhost:3111";

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Security headers. `frame-ancestors 'none'` blocks clickjacking, which
 * matters here because a click can open a wallet signing prompt.
 *
 * The inline script in index.html (the no-flash theme resolver) is allowed by
 * hash, so every other inline script is still refused. `style-src` needs
 * 'unsafe-inline' because React writes inline style attributes.
 */
/*
 * The inline script's hash is computed from index.html at startup, so editing
 * the script cannot leave a stale hash that silently blocks it.
 */
/*
 * The origin the bundle fetches from, as recorded at build time. Empty means
 * same origin; anything else must appear in connect-src.
 */
const BUNDLE_API_BASE = await (async () => {
  try {
    const raw = await file(`${OUT}/manifest.json`).json();
    return typeof raw?.apiBase === "string" ? raw.apiBase : "";
  } catch {
    return "";
  }
})();

const CONNECT_SRC = ["'self'", ...(BUNDLE_API_BASE ? [new URL(BUNDLE_API_BASE).origin] : [])].join(" ");

const INLINE_SCRIPT_HASH = await (async () => {
  const html = await file(`${ROOT}index.html`).text();
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) return "";
  return `sha256-${new Bun.CryptoHasher("sha256").update(match[1]).digest("base64")}`;
})();

const CSP = [
  "default-src 'self'",
  INLINE_SCRIPT_HASH ? `script-src 'self' '${INLINE_SCRIPT_HASH}'` : "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdn.fontshare.com",
  `connect-src ${CONNECT_SRC}`,
  "img-src 'self' data: https:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  // Legacy backstop for anything that predates frame-ancestors.
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/**
 * Headers a client must not be able to set through this proxy. Behind
 * TRUST_PROXY=1 the API rate limits by X-Forwarded-For, so forwarding the
 * client's own copy would let every request choose its bucket. A correct
 * reverse proxy overwrites these with what it observed.
 */
const SPOOFABLE = ["x-forwarded-for", "x-real-ip", "forwarded", "x-client-ip", "true-client-ip", "cf-connecting-ip"];

/**
 * A built file, as brotli or gzip when the client takes it and the build
 * wrote one. The type is the original file's: served as-is, the .br file
 * would be labelled by its own extension and the browser would refuse it.
 */
async function compressed(request: Request, path: string, type: string, cacheControl: string): Promise<Response> {
  const accepts = request.headers.get("accept-encoding") ?? "";
  for (const [encoding, suffix] of [
    ["br", ".br"],
    ["gzip", ".gz"],
  ] as const) {
    if (!accepts.includes(encoding)) continue;
    const packed = file(path + suffix);
    if (await packed.exists()) {
      return new Response(packed, {
        headers: {
          ...SECURITY_HEADERS,
          "content-type": type,
          "content-encoding": encoding,
          vary: "accept-encoding",
          "cache-control": cacheControl,
        },
      });
    }
  }
  return new Response(file(path), {
    headers: { ...SECURITY_HEADERS, "content-type": type, vary: "accept-encoding", "cache-control": cacheControl },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      const target = new URL(url.pathname + url.search, API);

      const headers = new Headers(request.headers);
      for (const name of SPOOFABLE) headers.delete(name);
      const peer = server.requestIP(request)?.address;
      if (peer) headers.set("x-forwarded-for", peer);

      // Duplex is required for a streamed body under fetch; without it a
      // POST proxied this way throws on Node-compatible runtimes.
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        // @ts-expect-error -- not in the DOM lib, required at runtime
        duplex: "half",
      });

      const type = upstream.headers.get("content-type") ?? "";
      const accepts = request.headers.get("accept-encoding") ?? "";
      if (
        request.method === "GET" &&
        type.includes("application/json") &&
        accepts.includes("gzip") &&
        !upstream.headers.has("content-encoding")
      ) {
        const body = new Uint8Array(await upstream.arrayBuffer());
        const out = new Headers(upstream.headers);
        out.delete("content-length");
        out.set("vary", "accept-encoding");
        if (body.byteLength < 1024) return new Response(body, { status: upstream.status, headers: out });
        out.set("content-encoding", "gzip");
        return new Response(Bun.gzipSync(body), { status: upstream.status, headers: out });
      }
      return upstream;
    }

    const asset = file(`${OUT}${url.pathname}`);
    if (url.pathname !== "/" && !/\.(br|gz)$/.test(url.pathname) && (await asset.exists())) {
      const hashed = /-[0-9a-z]{8}\.(js|css)(\.map)?$/.test(url.pathname) || /\.[0-9a-f]{8,}\./.test(url.pathname);
      const cover = url.pathname.startsWith("/covers/") || url.pathname.startsWith("/avatars/");
      return compressed(
        request,
        `${OUT}${url.pathname}`,
        asset.type,
        hashed ? IMMUTABLE : cover ? "public, max-age=604800" : "no-cache",
      );
    }

    return compressed(request, `${OUT}/index.html`, "text/html; charset=utf-8", "no-cache");
  },
});

console.log(`preview  http://localhost:${PORT}   (api proxied from ${API})`);
console.log(
  BUNDLE_API_BASE
    ? `         bundle fetches ${BUNDLE_API_BASE} — allowed in connect-src`
    : `         bundle fetches same origin`,
);
