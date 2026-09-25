/** Server entry point. Kept apart from app.ts so importing the app opens no database, clients or port. */

import { createApp } from "./app.ts";
import { createServices } from "./context.ts";

const port = Number(process.env["PORT"] ?? 3000);

/**
 * Request body cap. Bun's default is 128MB, buffered before any validation;
 * the largest legitimate body, a submit of twenty transactions, is about 33KB.
 */
const MAX_BODY_BYTES = 512 * 1024;

console.log(`API listening on http://localhost:${port}`);

const services = createServices();
// Warm the price history in the background: a cold fetch takes about a
// minute under the free tier's rate limit.
services.history?.ensureFresh();

const app = createApp(services);

// Warm the traders board views the app requests first: the first read checks
// what a hundred wallets hold, which takes about fifteen seconds.
setTimeout(() => {
  for (const query of [
    "hours=720&sortBy=pnl&limit=50&minVolumeUsd=25",
    "hours=168&sortBy=return&limit=3&minVolumeUsd=25",
  ]) {
    Promise.resolve(app.request(`/api/leaderboard?${query}`)).catch(() => undefined);
  }
}, 3_000);

/*
 * While a page has read prices in the last minute, refresh the snapshot on a
 * timer so each poll gets one a few seconds old. With nobody watching, nothing
 * is spent upstream.
 */
const REFRESH_MS = 4_000;
const WATCHING_MS = 60_000;
const MARKET_PATH = /\/api\/market(?:\?|$)/;
let lastMarketRead = 0;
setInterval(() => {
  if (Date.now() - lastMarketRead > WATCHING_MS) return;
  Promise.resolve(app.request("/api/market")).catch(() => undefined);
}, REFRESH_MS);

export default {
  port,
  fetch(request: Request, server: unknown) {
    if (MARKET_PATH.test(request.url)) lastMarketRead = Date.now();
    return app.fetch(request, server);
  },
  idleTimeout: 120,
  maxRequestBodySize: MAX_BODY_BYTES,
};
