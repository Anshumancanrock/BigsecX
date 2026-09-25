/**
 * Production build: typecheck, bundle with content-hashed names, copy public/,
 * precompress, and bake in the API base (API_BASE, default same origin).
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";

const ROOT = new URL(".", import.meta.url).pathname;
const OUT = `${ROOT}.build`;

// Same origin by default. Set API_BASE only when the API lives elsewhere,
// in which case that origin must also allow this one via CORS.
const API_BASE = process.env["API_BASE"] ?? "";

// `bun build` does not typecheck, so the build runs tsc first and refuses on errors.
// Resolved from ROOT, not the cwd: node_modules lives at the repository
// root and this script is usually run from apps/web.
const typecheck = Bun.spawnSync(
  ["bun", `${ROOT}../../node_modules/typescript/lib/tsc.js`, "--noEmit", "-p", `${ROOT}tsconfig.json`],
  { stdout: "inherit", stderr: "inherit" },
);
if (typecheck.exitCode !== 0) {
  console.error("BUILD REFUSED: the source does not typecheck.");
  process.exit(1);
}

// Only now clear the old build: a refused one leaves the last good build in
// place, rather than an empty directory for the dev server to serve.
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const result = await Bun.build({
  entrypoints: [`${ROOT}src/main.tsx`],
  outdir: OUT,
  // three.js, used only by the landing phone, is split into its own chunk.
  // Every file, entry points included, is named by content hash so it can be
  // cached forever; only index.html is ever revalidated.
  splitting: true,
  naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  minify: true,
  sourcemap: "linked",
  define: {
    "__API_BASE__": JSON.stringify(API_BASE),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// index.html names /main.js and /main.css (what the dev server serves);
// point it at the hashed files the build wrote.
const entryName = (extension: string) =>
  result.outputs
    .map((o) => o.path.split("/").pop()!)
    .find((name) => name.startsWith("main-") && name.endsWith(extension));
const mainJs = entryName(".js");
const mainCss = entryName(".css");
if (!mainJs || !mainCss) {
  console.error("BUILD REFUSED: could not find the hashed main.js and main.css in the output.");
  process.exit(1);
}
const html = (await Bun.file(`${ROOT}index.html`).text())
  .replace('src="/main.js"', `src="/${mainJs}"`)
  .replace('href="/main.css"', `href="/${mainCss}"`);
if (!html.includes(mainJs) || !html.includes(mainCss)) {
  console.error("BUILD REFUSED: index.html no longer references /main.js and /main.css where the build expects.");
  process.exit(1);
}
await Bun.write(`${OUT}/index.html`, html);

// public/ is served from the source tree in development, so it must be copied
// beside the bundle or its files would fall through to index.html in production.
await cp(`${ROOT}public`, OUT, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
});

// Record the API base the bundle fetches from, so preview.ts can derive a
// matching `connect-src` instead of assuming same origin.
await Bun.write(`${OUT}/manifest.json`, JSON.stringify({ apiBase: API_BASE }, null, 2));

/*
 * Fail the build if the API_BASE define did not take: a bundle that still
 * contains the localhost fallback works only on the machine that built it.
 */
const scripts = await Promise.all(
  result.outputs.filter((o) => o.path.endsWith(".js")).map((o) => Bun.file(o.path).text()),
);
if (API_BASE === "" && scripts.some((code) => code.includes("localhost:3111"))) {
  // Bun.build has already written the output, so delete it before exiting;
  // otherwise a later preview, deploy step or CI artifact could serve it.
  await rm(OUT, { recursive: true, force: true });
  console.error(
    "BUILD REFUSED: the bundle still contained the localhost fallback, so the\n" +
      "API_BASE define did not match. Output has been deleted so nothing can\n" +
      "serve it. Check the define token against src/lib/api.ts.",
  );
  process.exit(1);
}

/*
 * Precompress text assets once at build time; the server picks the .br or .gz
 * sibling by Accept-Encoding. Brotli brings the landing page to about a
 * quarter of its raw size. Source maps are left uncompressed.
 */
const glob = new Bun.Glob("*.{js,css,html,json}");
for await (const name of glob.scan(OUT)) {
  const bytes = new Uint8Array(await Bun.file(`${OUT}/${name}`).arrayBuffer());
  await Bun.write(
    `${OUT}/${name}.br`,
    brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } }),
  );
  await Bun.write(`${OUT}/${name}.gz`, gzipSync(bytes, { level: 9 }));
}

const sizes = await Promise.all(
  result.outputs.map(async (output) => {
    const bytes = await output.arrayBuffer();
    const gzipped = Bun.gzipSync(new Uint8Array(bytes)).byteLength;
    const name = output.path.split("/").pop();
    const brotli = name && !name.endsWith(".map") ? Bun.file(`${OUT}/${name}.br`).size : 0;
    return { path: name, bytes: bytes.byteLength, gzipped, brotli };
  }),
);

console.log(`API base: ${API_BASE === "" ? "(same origin)" : API_BASE}`);
for (const { path, bytes, gzipped, brotli } of sizes) {
  console.log(
    `  ${path?.padEnd(22)} ${(bytes / 1024).toFixed(1).padStart(8)} KB   ${(gzipped / 1024).toFixed(1).padStart(7)} KB gzipped` +
      (brotli ? `   ${(brotli / 1024).toFixed(1).padStart(7)} KB brotli` : ""),
  );
}
