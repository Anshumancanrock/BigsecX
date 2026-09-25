/**
 * Portfolio routes. Balances are read from the chain, never taken from the
 * caller, because they size trades.
 */

import { Hono } from "hono";
import { UNIVERSE, bySymbol, driftExceeded, sectorExposure, type Weight } from "@ps/core";
import { getSellableBalances, getSpendable, getStrandedBalances, type StrandedBalance } from "@ps/tx";
import type { Services } from "../context.ts";
import { publicStrategy } from "../lib/access.ts";
import { requireBase58Address } from "../lib/validate.ts";
import type { MarketSnapshot } from "@ps/market";

export interface PortfolioPosition {
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  readonly uiAmount: number;
  readonly priceUsd: number | null;
  readonly valueUsd: number | null;
  /** Share of the portfolio's priced value. Null when the price is missing. */
  readonly weight: number | null;
  /** The issuer has immobilised this account; the balance cannot be sold. */
  readonly frozen: boolean;
  readonly paused: boolean;
}

/*
 * The stranded-balance scan costs eight indexed RPC calls and an open
 * portfolio polls every thirty seconds, so each owner's result is kept for two
 * minutes. Keyed by the RPC client so separate service instances never share it.
 */
const STRANDED_TTL_MS = 120_000;
const STRANDED_MAX_OWNERS = 1_000;
const strandedCache = new WeakMap<object, Map<string, { at: number; value: Promise<Map<string, StrandedBalance>> }>>();

function strandedFor(
  services: Services,
  owner: string,
  scaleConfig: Parameters<typeof getStrandedBalances>[2],
  atUnixSeconds: number,
): Promise<Map<string, StrandedBalance>> {
  let byOwner = strandedCache.get(services.rpc);
  if (!byOwner) strandedCache.set(services.rpc, (byOwner = new Map()));
  const now = Date.now();
  const hit = byOwner.get(owner);
  if (hit && now - hit.at < STRANDED_TTL_MS) return hit.value;
  if (byOwner.size >= STRANDED_MAX_OWNERS) byOwner.delete(byOwner.keys().next().value!);
  const value = getStrandedBalances(services.rpc, owner, scaleConfig, atUnixSeconds);
  byOwner.delete(owner);
  byOwner.set(owner, { at: now, value });
  return value;
}

/** A wallet's positions, cash and weights, from chain balances and a market snapshot. */
export async function readPortfolio(
  services: Services,
  owner: string,
  snapshot: MarketSnapshot,
  /**
   * Also scan for tokens held outside the associated accounts. Off by default
   * because every build calls this, and the scan is slow for wallets with many
   * token accounts.
   */
  options: { readonly includeStranded?: boolean } = {},
): Promise<{
  readonly owner: string;
  readonly positions: PortfolioPosition[];
  readonly totalUsd: number;
  readonly unpriced: string[];
  readonly usdcUsd: number;
  readonly solLamports: number;
  readonly weights: Weight[];
  /** Held outside the associated account, so not shown above and not sellable here. */
  readonly elsewhere: { symbol: string; uiAmount: number; valueUsd: number | null; accounts: number }[];
}> {
  const scaleConfig = new Map(
    snapshot.tokens.map((t) => [
      t.token.symbol,
      { multiplier: t.multiplier, newMultiplier: t.multiplier, newMultiplierEffectiveTimestamp: 0 },
    ]),
  );
  const priceBySymbol = new Map(
    snapshot.tokens.flatMap((t) => (t.marketUsd === null ? [] : [[t.token.symbol, t.marketUsd] as const])),
  );
  const pausedBySymbol = new Map(snapshot.tokens.map((t) => [t.token.symbol, t.paused]));

  const [balances, spendable, stranded] = await Promise.all([
    getSellableBalances(services.rpc, owner, scaleConfig, snapshot.unixSeconds),
    getSpendable(services.rpc, owner),
    options.includeStranded
      ? strandedFor(services, owner, scaleConfig, snapshot.unixSeconds)
      : Promise.resolve(new Map()),
  ]);

  const positions: PortfolioPosition[] = [];
  const unpriced: string[] = [];
  let totalUsd = 0;

  for (const token of UNIVERSE) {
    const balance = balances.get(token.symbol);
    // A zero balance is not a position.
    if (!balance || balance.uiAmount <= 0) continue;

    const priceUsd = priceBySymbol.get(token.symbol) ?? null;
    const valueUsd = priceUsd === null ? null : balance.uiAmount * priceUsd;
    if (valueUsd === null) unpriced.push(token.symbol);
    else totalUsd += valueUsd;

    positions.push({
      symbol: token.symbol,
      name: token.name,
      mint: token.mint,
      uiAmount: balance.uiAmount,
      priceUsd,
      valueUsd,
      weight: null,
      frozen: balance.frozen,
      paused: pausedBySymbol.get(token.symbol) ?? false,
    });
  }

  // Weights are shares of priced value, so an unpriced position gets null.
  const withWeights = positions
    .map((p) => ({ ...p, weight: p.valueUsd === null || totalUsd <= 0 ? null : p.valueUsd / totalUsd }))
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  return {
    owner,
    positions: withWeights,
    totalUsd,
    unpriced,
    usdcUsd: spendable.usdc,
    solLamports: spendable.lamports,
    weights: withWeights.flatMap((p) => (p.weight === null ? [] : [{ symbol: p.symbol, weight: p.weight }])),
    // Kept out of totalUsd and positions, which describe what a swap can
    // spend: a sell sized against these balances would fail on chain.
    elsewhere: [...stranded.values()].map((b) => {
      const price = priceBySymbol.get(b.symbol) ?? null;
      return {
        symbol: b.symbol,
        uiAmount: b.uiAmount,
        valueUsd: price === null ? null : b.uiAmount * price,
        accounts: b.accounts,
      };
    }),
  };
}

export function registerPortfolioRoutes(
  app: Hono,
  services: Services,
  market: () => Promise<MarketSnapshot>,
): void {
  /** A wallet's live holdings, optionally measured against a published strategy (`?compare=<id>`). */
  app.get("/api/portfolio/:wallet", async (c) => {
    const owner = requireBase58Address(c.req.param("wallet"), "wallet");
    const snapshot = await market();
    const portfolio = await readPortfolio(services, owner, snapshot, { includeStranded: true });

    const compareId = c.req.query("compare");
    let comparison: unknown = null;
    if (compareId) {
      // The response echoes {id, name, weights}, so a draft must not resolve here.
      const strategy = publicStrategy(services.store, compareId);
      if (!strategy) return c.json({ error: `unknown strategy ${compareId}` }, 404);
      const drift = driftExceeded(portfolio.weights, strategy.weights, strategy.driftBps);
      comparison = {
        strategy: { id: strategy.id, name: strategy.name, weights: strategy.weights },
        driftBps: strategy.driftBps,
        exceeded: drift.exceeded,
        worst: drift.worst,
      };
    }

    return c.json({
      owner,
      asOf: snapshot.takenAt.toISOString(),
      totalUsd: portfolio.totalUsd,
      cash: {
        usdcUsd: portfolio.usdcUsd,
        solLamports: portfolio.solLamports,
        // A wallet without lamports cannot submit anything, whatever it holds.
        canPayFees: portfolio.solLamports >= 3_000_000,
      },
      positions: portfolio.positions,
      sectors: Object.fromEntries(sectorExposure(portfolio.weights)),
      // Non-empty means some position could not be valued, so totalUsd and
      // every weight understate the portfolio.
      unpriced: portfolio.unpriced,
      frozen: portfolio.positions.filter((p) => p.frozen).map((p) => p.symbol),
      elsewhere: portfolio.elsewhere,
      comparison,
    });
  });

  /** What a wallet can spend right now (USDC and SOL), checked before an amount is quoted. */
  app.get("/api/cash/:wallet", async (c) => {
    const owner = requireBase58Address(c.req.param("wallet"), "wallet");
    const spendable = await getSpendable(services.rpc, owner);
    return c.json({ owner, usdcUsd: spendable.usdc, solLamports: spendable.lamports });
  });

  /** Holdings for one symbol, for an asset page. */
  app.get("/api/portfolio/:wallet/:symbol", async (c) => {
    const owner = requireBase58Address(c.req.param("wallet"), "wallet");
    const token = bySymbol(c.req.param("symbol"));
    if (!token) return c.json({ error: "unknown symbol" }, 404);

    const snapshot = await market();
    const portfolio = await readPortfolio(services, owner, snapshot, { includeStranded: true });
    const position = portfolio.positions.find((p) => p.symbol === token.symbol);

    return c.json({
      owner,
      symbol: token.symbol,
      asOf: snapshot.takenAt.toISOString(),
      // An absent position is a zero position, not an error.
      position: position ?? {
        symbol: token.symbol,
        name: token.name,
        mint: token.mint,
        uiAmount: 0,
        priceUsd: snapshot.tokens.find((t) => t.token.symbol === token.symbol)?.marketUsd ?? null,
        valueUsd: 0,
        weight: 0,
        frozen: false,
        paused: snapshot.tokens.find((t) => t.token.symbol === token.symbol)?.paused ?? false,
      },
    });
  });
}
