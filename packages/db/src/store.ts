/**
 * Persistence for market snapshots, holder positions and index levels.
 *
 * Reads and writes go through this class rather than raw SQL at call sites, so
 * the shapes the rest of the app sees stay stable if the storage engine moves.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./schema.ts";

function defaultDatabasePath(): string {
  // packages/db/src -> repository root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(resolve(here, "..", "..", ".."), "data", "prestocks.db");
}

export interface SnapshotRow {
  readonly id: number;
  readonly takenAt: Date;
  readonly epoch: number;
}

export interface PriceRow {
  readonly symbol: string;
  readonly marketUsd: number | null;
  readonly markUsd: number | null;
  readonly liquidityUsd: number;
  readonly multiplier: number;
  readonly transferFeeBps: number;
}

export interface StrategyRow {
  readonly id: string;
  readonly kind: "index" | "user";
  readonly name: string;
  readonly description: string;
  readonly creator: string | null;
  readonly rebalance: string;
  readonly maxWeight: number;
  readonly minWeight: number;
  readonly maxSectorWeight: number | null;
  readonly driftBps: number;
  readonly published: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly weights: readonly { readonly symbol: string; readonly weight: number }[];
}

/** The strategy table's column names, as SQLite returns them. */
interface RawStrategyRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  creator: string | null;
  rebalance: string;
  max_weight: number;
  min_weight: number;
  max_sector_weight: number | null;
  drift_bps: number;
  published: number;
  created_at: number;
  updated_at: number;
}

export interface TradeRow {
  readonly signature: string;
  readonly owner: string;
  readonly symbol: string;
  readonly slot: number;
  readonly blockTime: number | null;
  /** Signed raw base units; positive is a buy. */
  readonly deltaRaw: bigint;
  readonly uiAmount: number;
  readonly valueUsd: number | null;
}

export class Store {
  readonly #db: Database;

  /**
   * @param path Defaults to `data/prestocks.db` resolved against the
   * repository root rather than the current directory. A relative default
   * silently gives the API and the indexer different databases when they are
   * started from different places, and the only symptom is an empty
   * leaderboard.
   */
  constructor(path = process.env["DATABASE_PATH"] ?? defaultDatabasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });
    migrate(this.#db);
  }

  get raw(): Database {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Record a snapshot and its prices atomically.
   *
   * Snapshots are unique by timestamp; re-running the indexer within the same
   * second reuses the existing row rather than failing, which keeps a retry
   * from being destructive.
   */
  writeSnapshot(args: {
    readonly takenAt: Date;
    readonly epoch: number;
    readonly prices: readonly PriceRow[];
  }): number {
    const takenAt = Math.floor(args.takenAt.getTime() / 1000);

    return this.#db.transaction(() => {
      this.#db
        .query("INSERT OR IGNORE INTO market_snapshot (taken_at, epoch) VALUES (?, ?)")
        .run(takenAt, args.epoch);
      const { id } = this.#db
        .query("SELECT id FROM market_snapshot WHERE taken_at = ?")
        .get(takenAt) as { id: number };

      const insert = this.#db.query(
        `INSERT OR REPLACE INTO token_price
           (snapshot_id, symbol, market_usd, mark_usd, liquidity_usd, multiplier, transfer_fee_bps)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const price of args.prices) {
        insert.run(
          id,
          price.symbol,
          price.marketUsd,
          price.markUsd,
          price.liquidityUsd,
          price.multiplier,
          price.transferFeeBps,
        );
      }
      return id;
    })();
  }

  writeIndexLevel(args: {
    readonly indexId: string;
    readonly snapshotId: number;
    readonly level: number;
    readonly weights: readonly { readonly symbol: string; readonly weight: number }[];
  }): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO index_level (index_id, snapshot_id, level, weights)
         VALUES (?, ?, ?, ?)`,
      )
      .run(args.indexId, args.snapshotId, args.level, JSON.stringify(args.weights));
  }

  latestSnapshot(): SnapshotRow | null {
    const row = this.#db
      .query("SELECT id, taken_at, epoch FROM market_snapshot ORDER BY taken_at DESC LIMIT 1")
      .get() as { id: number; taken_at: number; epoch: number } | null;
    return row ? { id: row.id, takenAt: new Date(row.taken_at * 1000), epoch: row.epoch } : null;
  }

  /** The snapshot closest to, but not after, `at`. */
  snapshotAtOrBefore(at: Date): SnapshotRow | null {
    const row = this.#db
      .query(
        `SELECT id, taken_at, epoch FROM market_snapshot
         WHERE taken_at <= ? ORDER BY taken_at DESC LIMIT 1`,
      )
      .get(Math.floor(at.getTime() / 1000)) as
      | { id: number; taken_at: number; epoch: number }
      | null;
    return row ? { id: row.id, takenAt: new Date(row.taken_at * 1000), epoch: row.epoch } : null;
  }

  writeTrades(trades: readonly TradeRow[]): number {
    const insert = this.#db.query(
      `INSERT OR IGNORE INTO trade
         (signature, owner, symbol, slot, block_time, delta_raw, ui_amount, value_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.#db.transaction(() => {
      let written = 0;
      for (const t of trades) {
        const result = insert.run(
          t.signature,
          t.owner,
          t.symbol,
          t.slot,
          t.blockTime,
          t.deltaRaw.toString(),
          t.uiAmount,
          t.valueUsd,
        );
        written += result.changes;
      }
      return written;
    })();
  }

  /** Newest signature already indexed for an address, mint or pool. */
  cursorFor(address: string): string | null {
    const row = this.#db
      .query("SELECT last_signature AS sig FROM index_cursor WHERE address = ?")
      .get(address) as { sig: string } | null;
    return row?.sig ?? null;
  }

  setCursor(address: string, signature: string): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO index_cursor (address, last_signature, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(address, signature, Math.floor(Date.now() / 1000));
  }

  tradesByOwnerSince(sinceSlot: number): Map<string, TradeRow[]> {
    const rows = this.#db
      .query(
        `SELECT signature, owner, symbol, slot, block_time AS blockTime,
                delta_raw AS deltaRaw, ui_amount AS uiAmount, value_usd AS valueUsd
         FROM trade WHERE slot >= ? ORDER BY slot ASC`,
      )
      .all(sinceSlot) as (Omit<TradeRow, "deltaRaw"> & { deltaRaw: string })[];

    const byOwner = new Map<string, TradeRow[]>();
    for (const row of rows) {
      const trade = { ...row, deltaRaw: BigInt(row.deltaRaw) };
      const existing = byOwner.get(row.owner);
      if (existing) existing.push(trade);
      else byOwner.set(row.owner, [trade]);
    }
    return byOwner;
  }

  /** Highest slot indexed, or null when nothing has been indexed. */
  latestTradeSlot(): number | null {
    const row = this.#db.query("SELECT MAX(slot) AS slot FROM trade").get() as {
      slot: number | null;
    };
    return row.slot;
  }

  tradesFor(owner: string, limit = 100): TradeRow[] {
    const rows = this.#db
      .query(
        `SELECT signature, owner, symbol, slot, block_time AS blockTime,
                delta_raw AS deltaRaw, ui_amount AS uiAmount, value_usd AS valueUsd
         FROM trade WHERE owner = ? ORDER BY slot DESC LIMIT ?`,
      )
      .all(owner, limit) as (Omit<TradeRow, "deltaRaw"> & { deltaRaw: string })[];
    return rows.map((r) => ({ ...r, deltaRaw: BigInt(r.deltaRaw) }));
  }

  /**
   * Save a strategy and its constituents atomically.
   *
   * A strategy whose weights half-saved would be a basket nobody authored,
   * so the constituent rows are replaced wholesale inside the transaction
   * rather than merged.
   */
  writeStrategy(strategy: StrategyRow): void {
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT OR REPLACE INTO strategy
             (id, kind, name, description, creator, rebalance,
              max_weight, min_weight, max_sector_weight, drift_bps,
              published, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          strategy.id,
          strategy.kind,
          strategy.name,
          strategy.description,
          strategy.creator,
          strategy.rebalance,
          strategy.maxWeight,
          strategy.minWeight,
          strategy.maxSectorWeight,
          strategy.driftBps,
          strategy.published ? 1 : 0,
          Math.floor(strategy.createdAt.getTime() / 1000),
          Math.floor(strategy.updatedAt.getTime() / 1000),
        );

      this.#db.query("DELETE FROM strategy_constituent WHERE strategy_id = ?").run(strategy.id);
      const insert = this.#db.query(
        "INSERT INTO strategy_constituent (strategy_id, symbol, weight) VALUES (?, ?, ?)",
      );
      for (const w of strategy.weights) insert.run(strategy.id, w.symbol, w.weight);
    })();
  }

  #hydrate(row: RawStrategyRow): StrategyRow {
    const weights = this.#db
      .query(
        "SELECT symbol, weight FROM strategy_constituent WHERE strategy_id = ? ORDER BY weight DESC",
      )
      .all(row.id) as { symbol: string; weight: number }[];

    return {
      id: row.id,
      kind: row.kind as StrategyRow["kind"],
      name: row.name,
      description: row.description,
      creator: row.creator,
      rebalance: row.rebalance,
      maxWeight: row.max_weight,
      minWeight: row.min_weight,
      maxSectorWeight: row.max_sector_weight,
      driftBps: row.drift_bps,
      published: row.published === 1,
      createdAt: new Date(row.created_at * 1000),
      updatedAt: new Date(row.updated_at * 1000),
      weights,
    };
  }

  getStrategy(id: string): StrategyRow | null {
    const row = this.#db.query("SELECT * FROM strategy WHERE id = ?").get(id) as
      | RawStrategyRow
      | null;
    return row ? this.#hydrate(row) : null;
  }

  /**
   * List strategies, newest first.
   *
   * `creator` returns that wallet's own drafts as well as its published work;
   * without it only published strategies are visible, because an unpublished
   * draft belongs to its author alone.
   */
  listStrategies(
    options: { readonly creator?: string; readonly limit?: number; readonly holding?: string } = {},
  ): StrategyRow[] {
    const limit = options.limit ?? 50;
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.creator) {
      clauses.push("creator = ?");
      params.push(options.creator);
    } else {
      clauses.push("published = 1");
    }
    if (options.holding) {
      clauses.push("id IN (SELECT strategy_id FROM strategy_constituent WHERE symbol = ?)");
      params.push(options.holding.toUpperCase());
    }

    const rows = this.#db
      .query(
        `SELECT * FROM strategy WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as RawStrategyRow[];
    return rows.map((row) => this.#hydrate(row));
  }

  deleteStrategy(id: string, creator: string): boolean {
    // Scoped to the creator so an id alone cannot delete someone else's work.
    const result = this.#db
      .query("DELETE FROM strategy WHERE id = ? AND creator = ?")
      .run(id, creator);
    return result.changes > 0;
  }

  /**
   * The level and weights last recorded for an index.
   *
   * The weights matter: a period's return must be measured with the basket
   * that was actually held during it, not with one recomputed from today's
   * valuations.
   */
  lastIndexState(indexId: string): {
    readonly level: number;
    readonly weights: { symbol: string; weight: number }[];
  } | null {
    const row = this.#db
      .query(
        `SELECT l.level AS level, l.weights AS weights
         FROM index_level l JOIN market_snapshot s ON s.id = l.snapshot_id
         WHERE l.index_id = ? ORDER BY s.taken_at DESC LIMIT 1`,
      )
      .get(indexId) as { level: number; weights: string } | null;
    if (!row) return null;

    try {
      return { level: row.level, weights: JSON.parse(row.weights) };
    } catch {
      // A malformed row must not take the indexer down; treat it as absent
      // and let the index restart from base.
      return null;
    }
  }

  indexHistory(indexId: string, limit = 500): { takenAt: Date; level: number }[] {
    const rows = this.#db
      .query(
        `SELECT s.taken_at AS takenAt, l.level AS level
         FROM index_level l JOIN market_snapshot s ON s.id = l.snapshot_id
         WHERE l.index_id = ? ORDER BY s.taken_at DESC LIMIT ?`,
      )
      .all(indexId, limit) as { takenAt: number; level: number }[];
    return rows.reverse().map((r) => ({ takenAt: new Date(r.takenAt * 1000), level: r.level }));
  }
}
