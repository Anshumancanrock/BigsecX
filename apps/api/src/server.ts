/**
 * Server entrypoint.
 *
 * Kept apart from the routes so importing the app in a test does not open a
 * database, construct clients, or bind a port.
 */

import { createApp } from "./index.ts";
import { createServices } from "./context.ts";

const port = Number(process.env["PORT"] ?? 3000);
console.log(`API listening on http://localhost:${port}`);

export default { port, fetch: createApp(createServices()).fetch, idleTimeout: 120 };
