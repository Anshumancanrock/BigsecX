/**
 * Company price history from GeckoTerminal's free candle API, paced under its
 * 30-requests-a-minute limit and cached on disk. Candles are priced per raw
 * token, so closes are stored raw and divided by the current multiplier when served.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UNIVERSE } from "@ps/core";

export interface DailyCandle {
  /** Start of the candle's period, in unix seconds. */
  readonly time: number;
  readonly close: number;
  readonly volumeUsd: number;
}

export interface PoolRef {
  readonly address: string;
  /** Which side of the pool the company's token is on. */
  readonly side: "base" | "quote";
  readonly reserveUsd: number;
  /** Traded in the last day. The ranking key: see `pools` below. */
  readonly volumeUsd?: number;
}

/** Where candles come from. An interface so tests need no network. */
export interface HistorySource {
  pools(mint: string): Promise<PoolRef[]>;
  daily(pool: PoolRef, days: number): Promise<DailyCandle[]>;
  /** Hourly candles, newest last. Optional: the daily chart does not need them. */
  hourly?(pool: PoolRef, hours: number): Promise<DailyCandle[]>;
}

const GECKO = "https://api.geckoterminal.com/api/v2";
/** Just over two seconds, which keeps a burst under 30 a minute. */
const MIN_INTERVAL_MS = 2_100;

/** GeckoTerminal's free API, paced to its published limit. */
export function geckoTerminal(options: { fetchImpl?: typeof fetch; minIntervalMs?: number } = {}): HistorySource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const interval = options.minIntervalMs ?? MIN_INTERVAL_MS;
  let nextAt = 0;

  async function get(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = nextAt - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      nextAt = Date.now() + interval;
      const response = await fetchImpl(`${GECKO}${path}`, {
        headers: { accept: "application/json;version=20230302" },
        signal: AbortSignal.timeout(20_000),
      });
      // Rate limited: back off for a whole window.
      if (response.status === 429) {
        nextAt = Date.now() + 30_000;
        continue;
      }
      if (!response.ok) throw new Error(`GeckoTerminal ${path}: HTTP ${response.status}`);
      return response.json();
    }
    throw new Error(`GeckoTerminal ${path}: rate limited`);
  }

  return {
    async pools(mint) {
      const body = (await get(`/networks/solana/tokens/${mint}/pools?page=1`)) as {
        data?: {
          attributes?: { address?: string; reserve_in_usd?: string; volume_usd?: { h24?: string } };
          relationships?: { base_token?: { data?: { id?: string } } };
        }[];
      };
      // Ranked by 24h volume, then reserves: the deepest pools can trade almost
      // nothing and have only weeks of candles, while a shallower USDC pool
      // trades daily and has months.
      return (body.data ?? [])
        .map((pool) => ({
          address: pool.attributes?.address ?? "",
          side: pool.relationships?.base_token?.data?.id === `solana_${mint}` ? ("base" as const) : ("quote" as const),
          reserveUsd: Number(pool.attributes?.reserve_in_usd ?? 0),
          volumeUsd: Number(pool.attributes?.volume_usd?.h24 ?? 0),
        }))
        .filter((pool) => pool.address && Number.isFinite(pool.reserveUsd))
        .sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0) || b.reserveUsd - a.reserveUsd);
    },

    async daily(pool, days) {
      const body = (await get(
        `/networks/solana/pools/${pool.address}/ohlcv/day?aggregate=1&limit=${days}&currency=usd&token=${pool.side}`,
      )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
      return (body.data?.attributes?.ohlcv_list ?? [])
        .filter((row) => row.length >= 6 && row.every((v) => Number.isFinite(v)))
        .map((row) => ({ time: row[0]!, close: row[4]!, volumeUsd: row[5]! }));
    },

    async hourly(pool, hours) {
      const body = (await get(
        `/networks/solana/pools/${pool.address}/ohlcv/hour?aggregate=1&limit=${hours}&currency=usd&token=${pool.side}`,
      )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
      return (body.data?.attributes?.ohlcv_list ?? [])
        .filter((row) => row.length >= 6 && row.every((v) => Number.isFinite(v)) && row[4]! > 0)
        .map((row) => ({ time: row[0]!, close: row[4]!, volumeUsd: row[5]! }))
        .sort((a, b) => a.time - b.time);
    },
  };
}

/** "2026-09-23" for a unix-seconds timestamp. */
export function dayOf(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

/**
 * One close per day across several pools: the close of the pool that traded
 * most that day, dropped when it is more than twice or under half the median
 * of the surrounding week (a new pool's first print, or a single bad trade).
 */
export function mergeDaily(perPool: readonly (readonly DailyCandle[])[]): Map<string, number> {
  const best = new Map<string, DailyCandle>();
  for (const candles of perPool) {
    for (const candle of candles) {
      if (!(candle.close > 0)) continue;
      const day = dayOf(candle.time);
      const current = best.get(day);
      if (!current || candle.volumeUsd > current.volumeUsd) best.set(day, candle);
    }
  }

  const days = [...best.keys()].sort();
  const closes = days.map((day) => best.get(day)!.close);
  const merged = new Map<string, number>();
  days.forEach((day, i) => {
    const window = closes.slice(Math.max(0, i - 3), i + 4).sort((a, b) => a - b);
    const median = window[Math.floor(window.length / 2)]!;
    const ratio = closes[i]! / median;
    if (ratio <= 2 && ratio >= 0.5) merged.set(day, closes[i]!);
  });
  return merged;
}

interface CacheFile {
  readonly fetchedAt: number;
  /** Raw-unit closes per symbol, keyed by day. */
  readonly bySymbol: Record<string, Record<string, number>>;
}

/** How long a fetched history is served before it is refreshed. */
const FRESH_MS = 6 * 60 * 60 * 1000;
/** How many pools per company are read. The rest are too thin to matter. */
const POOLS_PER_TOKEN = 3;
const DAYS = 365;

/** The hourly cache sits beside the daily one. */
function hourlyPath(dailyPath: string): string {
  return dailyPath.replace(/(\.json)?$/, "-hourly.json");
}

/** How long hourly prices are served before they are fetched again. */
const INTRADAY_FRESH_MS = 15 * 60 * 1000;
/** A week of hours: enough for the one-day and one-week charts. */
export const INTRADAY_HOURS = 168;

/** Daily and hourly closes for every company, refreshed in the background and cached on disk. */
export class PriceHistory {
  #data: CacheFile | null = null;
  #refreshing: Promise<void> | null = null;
  #lastError: string | null = null;
  /** The busiest pool per symbol, remembered from the last daily refresh. */
  readonly #pools = new Map<string, PoolRef>();
  #hourly: { fetchedAt: number; bySymbol: Record<string, Record<number, number>> } | null = null;
  #refreshingHourly: Promise<void> | null = null;

  constructor(
    private readonly source: HistorySource,
    private readonly cachePath: string | null = null,
  ) {
    if (cachePath) {
      try {
        const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile;
        if (parsed && typeof parsed.fetchedAt === "number" && parsed.bySymbol) this.#data = parsed;
      } catch {
        // No cache yet, or an unreadable one: the first refresh writes it.
      }
      // The hourly cache too, so a restart can serve it at once.
      try {
        const parsed = JSON.parse(readFileSync(hourlyPath(cachePath), "utf8")) as {
          fetchedAt: number;
          bySymbol: Record<string, Record<number, number>>;
        };
        if (parsed && typeof parsed.fetchedAt === "number" && parsed.bySymbol) this.#hourly = parsed;
      } catch {
        // Written after the first hourly refresh.
      }
    }
  }

  get fetchedAt(): number | null {
    return this.#data?.fetchedAt ?? null;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  /** Raw-unit closes per symbol, or an empty record before the first fetch. */
  closes(): Record<string, Record<string, number>> {
    return this.#data?.bySymbol ?? {};
  }

  /** Start a refresh when the data is missing or old. Never waits for it. */
  ensureFresh(): void {
    const stale = !this.#data || Date.now() - this.#data.fetchedAt > FRESH_MS;
    if (stale && !this.#refreshing) void this.refresh();
  }

  /** One refresh at a time; a caller arriving mid-refresh shares it. */
  refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const bySymbol: Record<string, Record<string, number>> = { ...(this.#data?.bySymbol ?? {}) };
      let fetchedAny = false;
      for (const token of UNIVERSE) {
        try {
          const pools = (await this.source.pools(token.mint)).slice(0, POOLS_PER_TOKEN);
          if (pools[0]) this.#pools.set(token.symbol, pools[0]);
          const perPool: DailyCandle[][] = [];
          for (const pool of pools) perPool.push(await this.source.daily(pool, DAYS));
          const merged = mergeDaily(perPool);
          if (merged.size > 0) {
            bySymbol[token.symbol] = Object.fromEntries(merged);
            fetchedAny = true;
          }
        } catch (error) {
          // One company failing keeps its previous history; the rest update.
          this.#lastError = `${token.symbol}: ${(error as Error).message}`;
        }
      }
      if (fetchedAny) {
        this.#data = { fetchedAt: Date.now(), bySymbol };
        if (this.cachePath) {
          try {
            mkdirSync(dirname(this.cachePath), { recursive: true });
            writeFileSync(this.cachePath, JSON.stringify(this.#data));
          } catch {
            // A read-only disk costs the restart speed-up, nothing else.
          }
        }
      }
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  get refreshing(): boolean {
    return this.#refreshing !== null;
  }

  // Hourly prices come from one pool per company, the busiest, because an hour
  // in a thin pool often has no trade at all.

  /** Raw-unit hourly closes per symbol, keyed by the hour's unix second. */
  hourlyCloses(): Record<string, Record<number, number>> {
    return this.#hourly?.bySymbol ?? {};
  }

  get hourlyFetchedAt(): number | null {
    return this.#hourly?.fetchedAt ?? null;
  }

  ensureHourlyFresh(): void {
    const stale = !this.#hourly || Date.now() - this.#hourly.fetchedAt > INTRADAY_FRESH_MS;
    if (stale && !this.#refreshingHourly && this.source.hourly) void this.refreshHourly();
  }

  refreshHourly(): Promise<void> {
    if (this.#refreshingHourly) return this.#refreshingHourly;
    const hourly = this.source.hourly?.bind(this.source);
    if (!hourly) return Promise.resolve();
    this.#refreshingHourly = (async () => {
      const bySymbol: Record<string, Record<number, number>> = { ...(this.#hourly?.bySymbol ?? {}) };
      let fetchedAny = false;
      for (const token of UNIVERSE) {
        try {
          let pool = this.#pools.get(token.symbol);
          if (!pool) {
            pool = (await this.source.pools(token.mint))[0];
            if (pool) this.#pools.set(token.symbol, pool);
          }
          if (!pool) continue;
          const candles = await hourly(pool, INTRADAY_HOURS);
          if (candles.length > 0) {
            bySymbol[token.symbol] = Object.fromEntries(candles.map((c) => [c.time, c.close]));
            fetchedAny = true;
          }
        } catch (error) {
          this.#lastError = `${token.symbol} hourly: ${(error as Error).message}`;
        }
      }
      if (fetchedAny) {
        this.#hourly = { fetchedAt: Date.now(), bySymbol };
        if (this.cachePath) {
          try {
            mkdirSync(dirname(this.cachePath), { recursive: true });
            writeFileSync(hourlyPath(this.cachePath), JSON.stringify(this.#hourly));
          } catch {
            // A read-only disk costs the restart speed-up, nothing else.
          }
        }
      }
    })().finally(() => {
      this.#refreshingHourly = null;
    });
    return this.#refreshingHourly;
  }
}
