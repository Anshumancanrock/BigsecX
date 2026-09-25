/**
 * Pyth as a reference price independent of the issuer's own mark. Of the eight
 * PreStocks names, Pyth covers OpenAI, Anthropic and SpaceX. Hermes rejects
 * price reads without an API key (HTTP 401), so without one no oracle is reported.
 */

import { Cache, RateLimiter, getJson } from "./http.ts";

const HERMES = "https://hermes.pyth.network";

/**
 * Feed ids for the PreStocks names Pyth covers. Pinned rather than searched by
 * name, so a newly listed feed with a similar name cannot become the reference.
 */
export const PYTH_FEED_IDS: Readonly<Record<string, string>> = {
  OPENAI: "96d4bb23a3db78fdb72b3a03ce80ead686096f324319166534d9a27c0519c483",
  ANTHROPIC: "5da511a7c68b17a3bc94380cab4756bc83ab87f86307af10ea58467a64b6689d",
  SPACEX: "2dbfb1791e75725227a90dbd23c6bdd83b80cc9d13011973c948b6aeacdf17b9",
};

export interface OraclePrice {
  readonly symbol: string;
  readonly priceUsd: number;
  readonly confidenceUsd: number;
  readonly publishedAt: Date;
}

interface HermesPrice {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

export class PythClient {
  readonly #cache = new Cache(64);
  readonly #limiter = new RateLimiter(10, 5);
  readonly #apiKey: string | undefined;

  constructor(apiKey = process.env["PYTH_API_KEY"]) {
    this.#apiKey = apiKey;
  }

  get available(): boolean {
    return this.#apiKey !== undefined && this.#apiKey.length > 0;
  }

  /**
   * Oracle prices for the requested symbols Pyth covers. Returns an empty map
   * instead of throwing: the oracle is a reference only, never a trade price.
   */
  async prices(symbols: readonly string[], ttlMs = 10_000): Promise<Map<string, OraclePrice>> {
    const covered = symbols.filter((s) => PYTH_FEED_IDS[s] !== undefined);
    if (covered.length === 0 || !this.available) return new Map();

    const ids = covered.map((s) => PYTH_FEED_IDS[s]).sort();
    const query = ids.map((id) => `ids[]=${id}`).join("&");

    try {
      const response = await this.#cache.fetch(`pyth:${ids.join(",")}`, ttlMs, () =>
        getJson<{ parsed?: HermesPrice[] }>(`${HERMES}/v2/updates/price/latest?${query}`, {
          upstream: "pyth-hermes",
          limiter: this.#limiter,
          headers: { authorization: `Bearer ${this.#apiKey}` },
        }),
      );

      const bySymbol = new Map<string, string>();
      for (const symbol of covered) bySymbol.set(PYTH_FEED_IDS[symbol] as string, symbol);

      const out = new Map<string, OraclePrice>();
      for (const entry of response.parsed ?? []) {
        // Hermes returns ids without a 0x prefix, but normalise anyway.
        const symbol = bySymbol.get(entry.id.replace(/^0x/, ""));
        if (!symbol) continue;
        const scale = 10 ** entry.price.expo;
        out.set(symbol, {
          symbol,
          priceUsd: Number(entry.price.price) * scale,
          confidenceUsd: Number(entry.price.conf) * scale,
          publishedAt: new Date(entry.price.publish_time * 1000),
        });
      }
      return out;
    } catch {
      // An oracle outage must not take a market page down with it.
      return new Map();
    }
  }
}

export type PriceTruthVerdict = "aligned" | "token-rich" | "token-cheap" | "unknown";

export interface PriceTruth {
  readonly symbol: string;
  readonly marketUsd: number | null;
  readonly markUsd: number | null;
  readonly oracleUsd: number | null;
  readonly oracleConfidenceUsd: number | null;
  readonly oracleAgeSeconds: number | null;
  readonly basisToMark: number | null;
  readonly basisToOracle: number | null;
  readonly referenceSpread: number | null;
  readonly verdict: PriceTruthVerdict;
}

/**
 * Compares a token's market price with the issuer mark and the oracle. The
 * verdict uses the oracle when present, since the issuer marks its own book.
 */
export function priceTruth(args: {
  readonly symbol: string;
  readonly marketUsd: number | null;
  readonly markUsd: number | null;
  readonly oracle: OraclePrice | undefined;
  readonly now: Date;
  readonly toleranceFraction?: number;
}): PriceTruth {
  const tolerance = args.toleranceFraction ?? 0.02;
  const oracleUsd = args.oracle?.priceUsd ?? null;

  const ratio = (reference: number | null): number | null =>
    args.marketUsd !== null && reference !== null && reference > 0
      ? args.marketUsd / reference - 1
      : null;

  const basisToMark = ratio(args.markUsd);
  const basisToOracle = ratio(oracleUsd);

  const referenceSpread =
    args.markUsd !== null && oracleUsd !== null && oracleUsd > 0
      ? args.markUsd / oracleUsd - 1
      : null;

  const against = basisToOracle ?? basisToMark;
  const verdict: PriceTruthVerdict =
    against === null ? "unknown" : against > tolerance ? "token-rich" : against < -tolerance ? "token-cheap" : "aligned";

  return {
    symbol: args.symbol,
    marketUsd: args.marketUsd,
    markUsd: args.markUsd,
    oracleUsd,
    oracleConfidenceUsd: args.oracle?.confidenceUsd ?? null,
    oracleAgeSeconds: args.oracle
      ? Math.max(0, Math.round((args.now.getTime() - args.oracle.publishedAt.getTime()) / 1000))
      : null,
    basisToMark,
    basisToOracle,
    referenceSpread,
    verdict,
  };
}
