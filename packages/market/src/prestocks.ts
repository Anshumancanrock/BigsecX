/**
 * Client for the PreStocks issuer API.
 *
 * Two endpoints exist. `/api/prestocks` is documented in the hackathon brief;
 * `/api/stats` is not documented anywhere but is public, returns 200, and
 * carries the only long history available for this market -- 412 days of
 * cumulative volume and 60 weeks of holder counts per symbol.
 */

import { Cache, RateLimiter, getJson } from "./http.ts";

const BASE = "https://prestocks.com";

/** One row of /api/prestocks. */
export interface IssuerToken {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly image: string;
  readonly external_url: string;
  /** The Token-2022 mint. */
  readonly contract_address: string;
  /** Issuer mark price per UI share. */
  readonly markPrice: number | null;
  readonly markValuation: number | null;
  /** Issuer's view of the traded price per UI share. Can be null. */
  readonly tokenPrice: number | null;
  readonly impliedValuation: number | null;
  /** Supply in UI (multiplier-adjusted) shares. */
  readonly supply: number | null;
}

/** /api/stats. Volume rows are CUMULATIVE, not daily. */
export interface IssuerStats {
  readonly volume: readonly ({ readonly date: string } & Record<string, number>)[];
  readonly holders: readonly ({ readonly week: string } & Record<string, number>)[];
  readonly launchDates: Readonly<Record<string, string>>;
  readonly volumeSymbols: readonly string[];
  readonly holderSymbols: readonly string[];
}

export class PreStocksClient {
  readonly #cache = new Cache();
  // Measured: this endpoint 429s under even light polling, so stay well under
  // one request per second and let the cache absorb the rest.
  readonly #limiter = new RateLimiter(3, 0.25);

  constructor(private readonly tokensTtlMs = 60_000, private readonly statsTtlMs = 600_000) {}

  tokens(): Promise<readonly IssuerToken[]> {
    return this.#cache.fetch(
      "tokens",
      this.tokensTtlMs,
      () =>
        getJson<readonly IssuerToken[]>(`${BASE}/api/prestocks`, {
          upstream: "prestocks",
          limiter: this.#limiter,
        }),
    );
  }

  stats(): Promise<IssuerStats> {
    return this.#cache.fetch(
      "stats",
      this.statsTtlMs,
      () =>
        getJson<IssuerStats>(`${BASE}/api/stats`, {
          upstream: "prestocks",
          limiter: this.#limiter,
        }),
    );
  }
}

/**
 * Turn the cumulative volume series into per-day volume.
 *
 * The raw series only ever increases; subtracting consecutive rows recovers the
 * daily figure. A negative delta would mean the issuer restated history, so it
 * is clamped to zero rather than propagated as a negative volume.
 */
export function dailyVolume(
  stats: IssuerStats,
): readonly { readonly date: string; readonly bySymbol: Readonly<Record<string, number>> }[] {
  const out: { date: string; bySymbol: Record<string, number> }[] = [];
  for (let i = 1; i < stats.volume.length; i++) {
    const today = stats.volume[i];
    const yesterday = stats.volume[i - 1];
    if (!today || !yesterday) continue;

    const bySymbol: Record<string, number> = {};
    for (const symbol of stats.volumeSymbols) {
      const delta = (today[symbol] ?? 0) - (yesterday[symbol] ?? 0);
      bySymbol[symbol] = delta > 0 ? delta : 0;
    }
    out.push({ date: today.date, bySymbol });
  }
  return out;
}

/** Week-over-week holder growth, as a fraction, per symbol. */
export function holderGrowth(stats: IssuerStats): Readonly<Record<string, number | null>> {
  const rows = stats.holders;
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const growth: Record<string, number | null> = {};

  for (const symbol of stats.holderSymbols) {
    const now = latest?.[symbol] ?? 0;
    const before = previous?.[symbol] ?? 0;
    // A symbol going from zero holders has undefined growth, not infinite.
    growth[symbol] = before > 0 ? now / before - 1 : null;
  }
  return growth;
}
