import type { Database } from "bun:sqlite";

const MIGRATIONS: readonly string[] = [
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
  `
  DROP TABLE IF EXISTS holder_position;
  `,
  // 4: key cursors on any address, since pools (mostly trades) are indexed too.
  `
  ALTER TABLE index_cursor RENAME COLUMN mint TO address;
  `,
  `
  CREATE TABLE strategy (
    id                TEXT    PRIMARY KEY,
    kind              TEXT    NOT NULL,
    name              TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    -- Null for system indexes, a wallet address for authored ones.
    creator           TEXT,
    rebalance         TEXT    NOT NULL,
    max_weight        REAL    NOT NULL,
    min_weight        REAL    NOT NULL,
    max_sector_weight REAL,
    drift_bps         INTEGER NOT NULL,
    published         INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX idx_strategy_creator   ON strategy (creator, updated_at);
  CREATE INDEX idx_strategy_published ON strategy (published, updated_at);

  CREATE TABLE strategy_constituent (
    strategy_id TEXT NOT NULL REFERENCES strategy (id) ON DELETE CASCADE,
    symbol      TEXT NOT NULL,
    weight      REAL NOT NULL,
    PRIMARY KEY (strategy_id, symbol)
  );
  CREATE INDEX idx_constituent_symbol ON strategy_constituent (symbol);
  `,
  `
  UPDATE market_snapshot SET taken_at = taken_at * 1000;
  `,
  `
  CREATE TABLE profile (
    wallet     TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL DEFAULT '',
    -- Lowercase. Null until the wallet picks one; SQLite lets a unique
    -- index hold any number of nulls.
    handle     TEXT,
    bio        TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_profile_handle ON profile (handle);

  CREATE TABLE follow (
    follower   TEXT    NOT NULL,
    followee   TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower, followee)
  );
  CREATE INDEX idx_follow_followee ON follow (followee, created_at);

  CREATE TABLE session (
    token_hash TEXT    PRIMARY KEY,
    wallet     TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_session_wallet ON session (wallet);
  `,
  // 8: a unique proof per session so a signature signs in once; expiry index.
  `
  ALTER TABLE session ADD COLUMN proof TEXT;
  CREATE UNIQUE INDEX idx_session_proof ON session (proof);
  CREATE INDEX idx_session_expires ON session (expires_at);
  `,
  `
  CREATE TABLE avatar (
    wallet     TEXT    PRIMARY KEY,
    kind       TEXT    NOT NULL CHECK (kind IN ('preset', 'upload')),
    preset     INTEGER,
    mime       TEXT,
    bytes      BLOB,
    updated_at INTEGER NOT NULL,
    CHECK (
      (kind = 'preset' AND preset IS NOT NULL AND bytes IS NULL AND mime IS NULL) OR
      (kind = 'upload' AND preset IS NULL AND bytes IS NOT NULL AND mime IS NOT NULL)
    )
  );
  `,
];

export function migrate(db: Database): number {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // The API and indexer both migrate this file at startup; without a busy
  // timeout the loser of the write-lock race fails with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000");

  for (let version = 0; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;

    // Read the version inside an IMMEDIATE transaction, which takes the write
    // lock first, so two processes starting together cannot both apply a
    // migration (6 is a non-idempotent UPDATE). The loser skips it.
    db.transaction(() => {
      const current = (db.query("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      if (current !== version) return;
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    }).immediate();
  }
  return MIGRATIONS.length;
}
