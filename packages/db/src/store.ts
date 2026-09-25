/**
 * Persistence for snapshots, trades, strategies and social data. Call sites go
 * through this class rather than raw SQL, so the shapes they see stay stable if
 * the storage engine changes.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./schema.ts";

function defaultDatabasePath(): string {
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
  readonly deltaRaw: bigint;
  readonly uiAmount: number;
  readonly valueUsd: number | null;
}

export interface ProfileRow {
  readonly wallet: string;
  readonly name: string;
  readonly handle: string | null;
  readonly bio: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AvatarImage {
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly updatedAt: number;
}

export interface FollowRow {
  readonly wallet: string;
  readonly at: number;
}

export interface TradeSummary {
  readonly count: number;
  readonly firstAt: number | null;
  readonly lastAt: number | null;
}

export class Store {
  readonly #db: Database;

  /**
   * @param path Defaults to `data/prestocks.db` under the repository root, not
   * the working directory, so the API and indexer share one database wherever
   * they are started.
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

  writeSnapshot(args: {
    readonly takenAt: Date;
    readonly epoch: number;
    readonly prices: readonly PriceRow[];
  }): number {
    const takenAt = args.takenAt.getTime();

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

  marketPricesNear(atMs: number, toleranceMs: number): { takenAt: number; prices: Map<string, number> } | null {
    const row = this.#db
      .query(
        `SELECT id, taken_at FROM market_snapshot
          WHERE taken_at BETWEEN ? AND ?
          ORDER BY ABS(taken_at - ?) LIMIT 1`,
      )
      .get(atMs - toleranceMs, atMs + toleranceMs, atMs) as { id: number; taken_at: number } | null;
    if (!row) return null;
    const prices = new Map<string, number>();
    for (const p of this.#db
      .query("SELECT symbol, market_usd FROM token_price WHERE snapshot_id = ? AND market_usd IS NOT NULL")
      .all(row.id) as { symbol: string; market_usd: number }[]) {
      prices.set(p.symbol, p.market_usd);
    }
    return { takenAt: row.taken_at, prices };
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
    return row ? { id: row.id, takenAt: new Date(row.taken_at), epoch: row.epoch } : null;
  }

  snapshotAtOrBefore(at: Date): SnapshotRow | null {
    const row = this.#db
      .query(
        `SELECT id, taken_at, epoch FROM market_snapshot
         WHERE taken_at <= ? ORDER BY taken_at DESC LIMIT 1`,
      )
      .get(at.getTime()) as { id: number; taken_at: number; epoch: number } | null;
    return row ? { id: row.id, takenAt: new Date(row.taken_at), epoch: row.epoch } : null;
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

  latestTradeSlot(): number | null {
    const row = this.#db.query("SELECT MAX(slot) AS slot FROM trade").get() as {
      slot: number | null;
    };
    return row.slot;
  }

  activeTraderCount(sinceSlot: number): number {
    const row = this.#db
      .query("SELECT COUNT(DISTINCT owner) AS n FROM trade WHERE slot >= ?")
      .get(sinceSlot) as { n: number };
    return row.n;
  }

  recentTrades(limit = 50): TradeRow[] {
    const rows = this.#db
      .query(
        `SELECT signature, owner, symbol, slot, block_time AS blockTime,
                delta_raw AS deltaRaw, ui_amount AS uiAmount, value_usd AS valueUsd
         FROM trade WHERE value_usd IS NOT NULL ORDER BY slot DESC LIMIT ?`,
      )
      .all(limit) as (Omit<TradeRow, "deltaRaw"> & { deltaRaw: string })[];
    return rows.map((r) => ({ ...r, deltaRaw: BigInt(r.deltaRaw) }));
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
   * List strategies, newest first. Drafts appear only with `includeDrafts`;
   * `creator` only narrows the list, since a wallet address is public and must
   * not expose that wallet's drafts.
   */
  listStrategies(
    options: {
      readonly creator?: string;
      readonly limit?: number;
      readonly holding?: string;
      readonly includeDrafts?: boolean;
    } = {},
  ): StrategyRow[] {
    const limit = options.limit ?? 50;
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (options.creator) {
      clauses.push("creator = ?");
      params.push(options.creator);
    }
    if (!options.includeDrafts) clauses.push("published = 1");
    if (clauses.length === 0) clauses.push("1 = 1");
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
    return rows.reverse().map((r) => ({ takenAt: new Date(r.takenAt), level: r.level }));
  }

  tradeSummary(owner: string): TradeSummary {
    const row = this.#db
      .query(
        `SELECT COUNT(*) AS count, MIN(block_time) AS firstAt, MAX(block_time) AS lastAt
         FROM trade WHERE owner = ?`,
      )
      .get(owner) as { count: number; firstAt: number | null; lastAt: number | null };
    return { count: row.count, firstAt: row.firstAt, lastAt: row.lastAt };
  }

  profile(wallet: string): ProfileRow | null {
    const row = this.#db
      .query(
        `SELECT wallet, name, handle, bio, created_at AS createdAt, updated_at AS updatedAt
         FROM profile WHERE wallet = ?`,
      )
      .get(wallet) as ProfileRow | null;
    return row ?? null;
  }

  profileByHandle(handle: string): ProfileRow | null {
    const row = this.#db
      .query(
        `SELECT wallet, name, handle, bio, created_at AS createdAt, updated_at AS updatedAt
         FROM profile WHERE handle = ?`,
      )
      .get(handle.toLowerCase()) as ProfileRow | null;
    return row ?? null;
  }

  profiles(wallets: readonly string[]): Map<string, ProfileRow> {
    const out = new Map<string, ProfileRow>();
    const unique = [...new Set(wallets)];
    // Chunked so no list can exceed SQLite's bound-parameter limit.
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const rows = this.#db
        .query(
          `SELECT wallet, name, handle, bio, created_at AS createdAt, updated_at AS updatedAt
           FROM profile WHERE wallet IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk) as ProfileRow[];
      for (const row of rows) out.set(row.wallet, row);
    }
    return out;
  }

  /**
   * Create or update a profile, keeping its creation time. Returns "taken",
   * rather than throwing, when another wallet already has the handle.
   */
  writeProfile(args: {
    readonly wallet: string;
    readonly name: string;
    readonly handle: string | null;
    readonly bio: string;
    readonly now: number;
  }): "ok" | "taken" {
    const owner = args.handle === null ? null : this.profileByHandle(args.handle);
    if (owner && owner.wallet !== args.wallet) return "taken";
    try {
      this.#db
        .query(
          `INSERT INTO profile (wallet, name, handle, bio, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (wallet) DO UPDATE SET
             name = excluded.name, handle = excluded.handle, bio = excluded.bio,
             updated_at = excluded.updated_at`,
        )
        .run(args.wallet, args.name, args.handle, args.bio, args.now, args.now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return "taken";
      throw error;
    }
    return "ok";
  }

  /**
   * Each wallet's picture as a short token: "p3" for preset 3, "u<updatedAt>"
   * for an upload, so the token changes with every upload and a link built from
   * it is never stale. Wallets with no row are absent.
   */
  avatars(wallets: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    const unique = [...new Set(wallets)];
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const rows = this.#db
        .query(
          `SELECT wallet, kind, preset, updated_at AS updatedAt
           FROM avatar WHERE wallet IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk) as { wallet: string; kind: string; preset: number | null; updatedAt: number }[];
      for (const row of rows) out.set(row.wallet, row.kind === "upload" ? `u${row.updatedAt}` : `p${row.preset}`);
    }
    return out;
  }

  avatar(wallet: string): string | null {
    return this.avatars([wallet]).get(wallet) ?? null;
  }

  avatarImage(wallet: string): AvatarImage | null {
    const row = this.#db
      .query(`SELECT mime, bytes, updated_at AS updatedAt FROM avatar WHERE wallet = ? AND kind = 'upload'`)
      .get(wallet) as { mime: string; bytes: Uint8Array; updatedAt: number } | null;
    return row ? { mime: row.mime, bytes: new Uint8Array(row.bytes), updatedAt: row.updatedAt } : null;
  }

  // Writes keep updated_at increasing so two uploads in one millisecond get
  // different tokens and a cached first picture is never shown for the second.

  setAvatarPreset(wallet: string, preset: number, now: number): void {
    this.#db
      .query(
        `INSERT INTO avatar (wallet, kind, preset, mime, bytes, updated_at) VALUES (?, 'preset', ?, NULL, NULL, ?)
         ON CONFLICT (wallet) DO UPDATE SET kind = 'preset', preset = excluded.preset, mime = NULL, bytes = NULL,
           updated_at = MAX(excluded.updated_at, avatar.updated_at + 1)`,
      )
      .run(wallet, preset, now);
  }

  setAvatarUpload(wallet: string, mime: string, bytes: Uint8Array, now: number): void {
    this.#db
      .query(
        `INSERT INTO avatar (wallet, kind, preset, mime, bytes, updated_at) VALUES (?, 'upload', NULL, ?, ?, ?)
         ON CONFLICT (wallet) DO UPDATE SET kind = 'upload', preset = NULL, mime = excluded.mime, bytes = excluded.bytes,
           updated_at = MAX(excluded.updated_at, avatar.updated_at + 1)`,
      )
      .run(wallet, mime, bytes, now);
  }

  clearAvatar(wallet: string): void {
    this.#db.query("DELETE FROM avatar WHERE wallet = ?").run(wallet);
  }

  follow(follower: string, followee: string, now: number): void {
    this.#db
      .query("INSERT OR IGNORE INTO follow (follower, followee, created_at) VALUES (?, ?, ?)")
      .run(follower, followee, now);
  }

  unfollow(follower: string, followee: string): void {
    this.#db.query("DELETE FROM follow WHERE follower = ? AND followee = ?").run(follower, followee);
  }

  isFollowing(follower: string, followee: string): boolean {
    return (
      this.#db.query("SELECT 1 AS yes FROM follow WHERE follower = ? AND followee = ?").get(follower, followee) !==
      null
    );
  }

  followCounts(wallet: string): { readonly followers: number; readonly following: number } {
    const followers = this.#db.query("SELECT COUNT(*) AS n FROM follow WHERE followee = ?").get(wallet) as {
      n: number;
    };
    const following = this.#db.query("SELECT COUNT(*) AS n FROM follow WHERE follower = ?").get(wallet) as {
      n: number;
    };
    return { followers: followers.n, following: following.n };
  }

  mutualFollowers(viewer: string, wallet: string): number {
    const row = this.#db
      .query(
        `SELECT COUNT(*) AS n FROM follow f
         WHERE f.followee = ? AND f.follower IN (SELECT followee FROM follow WHERE follower = ?)`,
      )
      .get(wallet, viewer) as { n: number };
    return row.n;
  }

  followers(wallet: string, limit = 100): FollowRow[] {
    return this.#db
      .query(
        `SELECT follower AS wallet, created_at AS at FROM follow
         WHERE followee = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(wallet, limit) as FollowRow[];
  }

  following(wallet: string, limit = 100): FollowRow[] {
    return this.#db
      .query(
        `SELECT followee AS wallet, created_at AS at FROM follow
         WHERE follower = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(wallet, limit) as FollowRow[];
  }

  followedTrades(follower: string, limit = 50): TradeRow[] {
    const rows = this.#db
      .query(
        `SELECT t.signature, t.owner, t.symbol, t.slot, t.block_time AS blockTime,
                t.delta_raw AS deltaRaw, t.ui_amount AS uiAmount, t.value_usd AS valueUsd
         FROM trade t JOIN follow f ON f.followee = t.owner
         WHERE f.follower = ? AND t.value_usd IS NOT NULL
         ORDER BY t.slot DESC LIMIT ?`,
      )
      .all(follower, limit) as (Omit<TradeRow, "deltaRaw"> & { deltaRaw: string })[];
    return rows.map((r) => ({ ...r, deltaRaw: BigInt(r.deltaRaw) }));
  }

  /**
   * Record a session by the hash of its token.
   *
   * `proof` digests the signature that bought it and is unique among stored
   * sessions, so a spent signature returns "used" even on a restarted or
   * second server. A wallet keeps its newest `keep` sessions, and expired
   * sessions are swept here.
   */
  createSession(
    tokenHash: string,
    wallet: string,
    now: number,
    expiresAt: number,
    proof: string | null = null,
    keep = 10,
  ): "ok" | "used" {
    try {
      this.#db.transaction(() => {
        this.#db.query("DELETE FROM session WHERE expires_at <= ?").run(now);
        this.#db
          .query("INSERT INTO session (token_hash, wallet, created_at, expires_at, proof) VALUES (?, ?, ?, ?, ?)")
          .run(tokenHash, wallet, now, expiresAt, proof);
        this.#db
          .query(
            `DELETE FROM session WHERE wallet = ? AND token_hash NOT IN
               (SELECT token_hash FROM session WHERE wallet = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
          )
          .run(wallet, wallet, keep);
      })();
    } catch (error) {
      if (String(error).includes("UNIQUE")) return "used";
      throw error;
    }
    return "ok";
  }

  sessionCount(wallet: string, now: number): number {
    const row = this.#db
      .query("SELECT COUNT(*) AS n FROM session WHERE wallet = ? AND expires_at > ?")
      .get(wallet, now) as { n: number };
    return row.n;
  }

  sessionWallet(tokenHash: string, now: number): string | null {
    const row = this.#db
      .query("SELECT wallet FROM session WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, now) as { wallet: string } | null;
    return row?.wallet ?? null;
  }

  endSession(tokenHash: string): void {
    this.#db.query("DELETE FROM session WHERE token_hash = ?").run(tokenHash);
  }
}
