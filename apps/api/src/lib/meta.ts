import { UNIVERSE } from "@ps/core";
import { Cache } from "@ps/market";

export interface TokenMeta {
  readonly iconUrl: string | null;
  readonly holders: number | null;
  readonly volume24hUsd: number | null;
  readonly traders24h: number | null;
  readonly verified: boolean;
}

const DIRECTORY = "https://lite-api.jup.ag/tokens/v2/search";
const TTL_MS = 10 * 60_000;
const STALE_MS = 6 * 60 * 60_000;

interface DirectoryEntry {
  readonly id?: string;
  readonly icon?: string;
  readonly holderCount?: number;
  readonly tags?: readonly string[];
  readonly stats24h?: { readonly buyVolume?: number; readonly sellVolume?: number; readonly numTraders?: number };
}

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function safeIcon(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseDirectory(entries: readonly DirectoryEntry[]): Map<string, TokenMeta> {
  const bySymbol = new Map<string, TokenMeta>();
  for (const token of UNIVERSE) {
    const entry = entries.find((e) => e.id === token.mint);
    if (!entry) continue;
    const buy = finite(entry.stats24h?.buyVolume);
    const sell = finite(entry.stats24h?.sellVolume);
    bySymbol.set(token.symbol, {
      iconUrl: safeIcon(entry.icon),
      holders: finite(entry.holderCount),
      volume24hUsd: buy === null && sell === null ? null : (buy ?? 0) + (sell ?? 0),
      traders24h: finite(entry.stats24h?.numTraders),
      verified: Boolean(entry.tags?.includes("verified")),
    });
  }
  return bySymbol;
}

export function tokenMeta(fetchImpl: typeof fetch = fetch): () => Promise<Map<string, TokenMeta>> {
  const cache = new Cache(1);
  const load = async () => {
    const query = UNIVERSE.map((t) => t.mint).join(",");
    const response = await fetchImpl(`${DIRECTORY}?query=${query}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`token directory: HTTP ${response.status}`);
    const body = (await response.json()) as unknown;
    return parseDirectory(Array.isArray(body) ? (body as DirectoryEntry[]) : []);
  };
  return () => cache.fetch("meta", TTL_MS, load, STALE_MS, { revalidateInBackground: true });
}
