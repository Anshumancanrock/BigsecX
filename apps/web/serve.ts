import { file } from "bun";

const ROOT = new URL(".", import.meta.url).pathname;
const OUT = `${ROOT}.build`;
const PORT = Number(process.env.WEB_PORT ?? 3000);

async function build() {
  const result = await Bun.build({
    entrypoints: [`${ROOT}src/main.tsx`],
    outdir: OUT,
    splitting: true,
    naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: {
      "__API_BASE__": JSON.stringify(process.env.API_BASE ?? "http://localhost:3111"),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new AggregateError(result.logs, "build failed");
  }
}

await build();

Bun.serve({
  port: PORT,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/main.js" || pathname === "/main.css") {
      await build();
      return new Response(file(`${OUT}${pathname}`), {
        headers: { "cache-control": "no-store" },
      });
    }

    if (pathname.startsWith("/chunk-")) {
      const chunk = file(`${OUT}${pathname}`);
      if (await chunk.exists()) return new Response(chunk, { headers: { "cache-control": "no-store" } });
    }

    const asset = file(`${ROOT}public${pathname}`);
    if (pathname !== "/" && (await asset.exists())) return new Response(asset);

    return new Response(file(`${ROOT}index.html`), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
});

console.log(`web  http://localhost:${PORT}`);
