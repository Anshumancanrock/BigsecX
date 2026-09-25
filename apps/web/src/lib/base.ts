/*
 * The API origin, in its own module so code that only needs a URL (avatar
 * links) does not import the client, and tests that mock the client keep it.
 */

/**
 * The API base URL, from the `__API_BASE__` define set by build.ts. A bundler
 * define cannot match an optional chain such as `import.meta.env?.API_BASE`,
 * hence the dedicated token. `typeof` covers builds without the define; an
 * empty string means same origin.
 */
declare const __API_BASE__: string | undefined;

export const API_BASE: string = typeof __API_BASE__ === "string" ? __API_BASE__ : "http://localhost:3111";

/** Where a wallet's uploaded picture is served; `version` comes from its avatar token. */
export function avatarImageUrl(wallet: string, version: string): string {
  return `${API_BASE}/api/avatars/${encodeURIComponent(wallet)}?v=${encodeURIComponent(version)}`;
}
