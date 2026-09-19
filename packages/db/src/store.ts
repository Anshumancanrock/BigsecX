/**
 * Persistence for market snapshots, holder positions and index levels.
 *
 * Reads and writes go through this class rather than raw SQL at call sites, so
 * the shapes the rest of the app sees stay stable if the storage engine moves.
 */

import { Database } from "bun:sqlite";
import { migrate } from "./schema.ts";

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

export interface TraderActivityRow {
  readonly owner: string;
  readonly trades: number;
  readonly volumeUsd: number;
  readonly netUsd: number;
  readonly lastSlot: number;
}

export interface PositionRow {
  readonly owner: string;
  readonly symbol: string;
  readonly uiAmount: number;
  readonly valueUsd: number;
}

export class Store {
  readonly #db: Database;

  constructor(path = process.env["DATABASE_PATH"] ?? "data/prestocks.db") {
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

  writePositions(snapshotId: number, positions: readonly PositionRow[]): void {
    const insert = this.#db.query(
      `INSERT OR REPLACE INTO holder_position
         (snapshot_id, owner, symbol, ui_amount, value_usd)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.#db.transaction(() => {
      for (const p of positions) {
        insert.run(snapshotId, p.owner, p.symbol, p.uiAmount, p.valueUsd);
      }
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

  positionsAt(snapshotId: number): PositionRow[] {
    return this.#db
      .query(
        `SELECT owner, symbol, ui_amount AS uiAmount, value_usd AS valueUsd
         FROM holder_position WHERE snapshot_id = ?`,
      )
      .all(snapshotId) as PositionRow[];
  }

  /** Total portfolio value per owner at one snapshot. */
  portfolioValuesAt(snapshotId: number): Map<string, number> {
    const rows = this.#db
      .query(
        `SELECT owner, SUM(value_usd) AS total FROM holder_position
         WHERE snapshot_id = ? GROUP BY owner`,
      )
      .all(snapshotId) as { owner: string; total: number }[];
    return new Map(rows.map((r) => [r.owner, r.total]));
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

  cursorFor(mint: string): string | null {
    const row = this.#db
      .query("SELECT last_signature AS sig FROM index_cursor WHERE mint = ?")
      .get(mint) as { sig: string } | null;
    return row?.sig ?? null;
  }

  setCursor(mint: string, signature: string): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO index_cursor (mint, last_signature, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(mint, signature, Math.floor(Date.now() / 1000));
  }

  /**
   * Net traded volume and flow per wallet since a slot.
   *
   * `netUsd` is signed: negative means the wallet spent more than it realised
   * over the window, which is what accumulating looks like.
   */
  traderActivity(sinceSlot: number): TraderActivityRow[] {
    return this.#db
      .query(
        `SELECT owner,
                COUNT(*)                AS trades,
                SUM(ABS(value_usd))     AS volumeUsd,
                SUM(value_usd)          AS netUsd,
                MAX(slot)               AS lastSlot
         FROM trade
         WHERE slot >= ? AND value_usd IS NOT NULL
         GROUP BY owner
         ORDER BY volumeUsd DESC`,
      )
      .all(sinceSlot) as TraderActivityRow[];
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
