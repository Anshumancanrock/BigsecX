import { Cache, RateLimiter, getJson } from "./http.ts";

const BASE = "https://prestocks.com";

export interface IssuerToken {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly image: string;
  readonly external_url: string;
  /** The Token-2022 mint. */
  readonly contract_address: string;
  readonly markPrice: number | null;
  readonly markValuation: number | null;
  readonly tokenPrice: number | null;
  readonly impliedValuation: number | null;
  /** Supply in UI (multiplier-adjusted) shares. */
  readonly supply: number | null;
}

export interface IssuerStats {
  readonly volume: readonly ({ readonly date: string } & Record<string, number>)[];
  readonly holders: readonly ({ readonly week: string } & Record<string, number>)[];
  readonly launchDates: Readonly<Record<string, string>>;
  readonly volumeSymbols: readonly string[];
  readonly holderSymbols: readonly string[];
}

export class PreStocksClient {
  readonly #cache = new Cache();
  // Returns 429 under light polling: a burst of 3, then one request per 4 s,
  // with the cache absorbing the rest.
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

export function volumeSeries(
  stats: IssuerStats,
  symbol: string,
  days = 90,
): { readonly date: string; readonly usd: number }[] {
  const daily = dailyVolume(stats);
  return daily
    .slice(-days)
    .map((row) => ({ date: row.date, usd: row.bySymbol[symbol] ?? 0 }));
}

export function holderSeries(
  stats: IssuerStats,
  symbol: string,
  weeks = 52,
): { readonly week: string; readonly holders: number }[] {
  return stats.holders
    .slice(-weeks)
    .map((row) => ({ week: row.week, holders: Number(row[symbol] ?? 0) }));
}

/**
 * Volume per symbol for the most recent complete day. The issuer's newest row
 * is the day in progress, so the one before it is used.
 */
export function latestDailyVolume(stats: IssuerStats): Readonly<Record<string, number>> {
  const daily = dailyVolume(stats);
  return daily[daily.length - 2]?.bySymbol ?? daily[daily.length - 1]?.bySymbol ?? {};
}

export function latestHolders(stats: IssuerStats): Readonly<Record<string, number>> {
  const row = stats.holders[stats.holders.length - 1];
  if (!row) return {};
  const out: Record<string, number> = {};
  for (const symbol of stats.holderSymbols) out[symbol] = Number(row[symbol] ?? 0);
  return out;
}

export function holderGrowth(stats: IssuerStats): Readonly<Record<string, number | null>> {
  const rows = stats.holders;
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const growth: Record<string, number | null> = {};

  for (const symbol of stats.holderSymbols) {
    const now = latest?.[symbol] ?? 0;
    const before = previous?.[symbol] ?? 0;
    growth[symbol] = before > 0 ? now / before - 1 : null;
  }
  return growth;
}
