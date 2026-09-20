/**
 * SQLite schema and migrations.
 *
 * SQLite because the workload is a few hundred rows per snapshot and a handful
 * of readers: Postgres would add an operational dependency without buying
 * anything at this size. The schema is deliberately written in plain portable
 * SQL so moving later is a connection change rather than a rewrite.
 *
 * Migrations run forward only, tracked by `user_version`.
 */

import type { Database } from "bun:sqlite";

const MIGRATIONS: readonly string[] = [
  // 1: market snapshots, prices, holder positions, index levels
  `
  CREATE TABLE market_snapshot (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    taken_at   INTEGER NOT NULL,
    epoch      INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_snapshot_taken_at ON market_snapshot (taken_at);

  CREATE TABLE token_price (
    snapshot_id      INTEGER NOT NULL REFERENCES market_snapshot (id) ON DELETE CASCADE,
    symbol           TEXT    NOT NULL,
    -- Nullable on purpose: the issuer API returns a null price for some
    -- symbols, and storing zero would read as "worthless" rather than
    -- "unknown".
    market_usd       REAL,
    mark_usd         REAL,
    liquidity_usd    REAL    NOT NULL,
    multiplier       REAL    NOT NULL,
    transfer_fee_bps INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, symbol)
  );

  CREATE TABLE holder_position (
    snapshot_id INTEGER NOT NULL REFERENCES market_snapshot (id) ON DELETE CASCADE,
    owner       TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    ui_amount   REAL    NOT NULL,
    value_usd   REAL    NOT NULL,
    PRIMARY KEY (snapshot_id, owner, symbol)
  );
  CREATE INDEX idx_holder_owner ON holder_position (owner, snapshot_id);

  CREATE TABLE index_level (
    index_id    TEXT    NOT NULL,
    snapshot_id INTEGER NOT NULL REFERENCES market_snapshot (id) ON DELETE CASCADE,
    level       REAL    NOT NULL,
    weights     TEXT    NOT NULL,
    PRIMARY KEY (index_id, snapshot_id)
  );
  `,
  // 2: reconstructed trades and per-mint indexing cursors
  `
  CREATE TABLE trade (
    signature   TEXT    NOT NULL,
    owner       TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    slot        INTEGER NOT NULL,
    block_time  INTEGER,
    -- Signed: positive is a buy. Stored as TEXT because these are u64-scale
    -- values and SQLite INTEGER would silently lose precision at the top end.
    delta_raw   TEXT    NOT NULL,
    ui_amount   REAL    NOT NULL,
    -- Notional in USD, valued at the price when the trade was seen. Null when
    -- no price was available for that symbol at the time.
    value_usd   REAL,
    PRIMARY KEY (signature, owner, symbol)
  );
  CREATE INDEX idx_trade_owner ON trade (owner, slot);
  CREATE INDEX idx_trade_slot  ON trade (slot);

  CREATE TABLE index_cursor (
    mint            TEXT PRIMARY KEY,
    last_signature  TEXT NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  `,
  // 3: drop holder snapshots. Every free RPC endpoint refuses
  // getTokenLargestAccounts, so this table was never populated; trades
  // reconstructed from transaction history replaced it. Leaving the table in
  // place invited reads against a source nothing writes, which is exactly the
  // bug that shipped -- the leaderboard queried it and silently returned
  // nothing.
  `
  DROP TABLE IF EXISTS holder_position;
  `,
];

export function migrate(db: Database): number {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    // Each migration is one transaction: a half-applied schema is worse than
    // a failed startup.
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
  return MIGRATIONS.length;
}
