import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Services } from "./context.ts";
import { Unauthorized } from "./lib/auth.ts";
import { marketCache } from "./lib/market-cache.ts";
import { throttle } from "./lib/throttle.ts";
import { BadRequest } from "./lib/validate.ts";
import { registerAssetRoutes } from "./routes/assets.ts";
import { registerCopyRoutes } from "./routes/copy.ts";
import { registerExitRoutes } from "./routes/exit.ts";
import { registerHistoryRoutes } from "./routes/history.ts";
import { registerLeaderboardRoutes } from "./routes/leaderboard.ts";
import { registerMarketRoutes } from "./routes/market.ts";
import { registerMirrorRoutes } from "./routes/mirror.ts";
import { registerPortfolioRoutes } from "./routes/portfolio.ts";
import { registerSocialRoutes } from "./routes/social.ts";
import { registerStrategyRoutes } from "./routes/strategies.ts";
import { registerSubmitRoutes } from "./routes/submit.ts";
import { registerTraderRoutes } from "./routes/traders.ts";

export function createApp(services: Services): Hono {
  const app = new Hono();
  const { market, tradingMarket } = marketCache(services);

  // Open by default for local work. A deployment lists its origins in
  // ALLOWED_ORIGINS, since the build and submit routes spend a shared
  // upstream quota that any site could otherwise drive from its visitors.
  const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    "/*",
    cors({
      origin: allowedOrigins.length === 0 ? "*" : (origin) => (allowedOrigins.includes(origin) ? origin : null),
    }),
  );

  app.use("/api/*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    // Responses are wallet-specific unless a route sets its own policy (profile pictures do).
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  });

  // Writes must be JSON. Other content types are CORS "simple requests" that
  // skip the preflight, and the preflight is where ALLOWED_ORIGINS applies.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "POST" && c.req.method !== "PUT" && c.req.method !== "DELETE") {
      return next();
    }
    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().split(";")[0]?.trim().endsWith("/json")) {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
    return next();
  });

  app.use("/*", throttle());

  registerAssetRoutes(app, services, market);
  registerStrategyRoutes(app, services);
  registerSocialRoutes(app, services);
  registerPortfolioRoutes(app, services, market);
  registerTraderRoutes(app, services, market);
  registerHistoryRoutes(app, services, market);
  registerCopyRoutes(app, services, tradingMarket);
  registerSubmitRoutes(app, services);
  registerExitRoutes(app, services, tradingMarket);

  app.get("/health", (c) => c.json({ ok: true }));
  registerMarketRoutes(app, services, market);
  registerLeaderboardRoutes(app, services, market);
  registerMirrorRoutes(app, services, tradingMarket);

  app.onError((error, c) => {
    if (error instanceof BadRequest) return c.json({ error: error.message }, 400);
    if (error instanceof Unauthorized) return c.json({ error: error.message }, 401);
    console.error("request failed:", error);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
