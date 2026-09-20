/**
 * Portfolio routes: what a wallet actually holds, right now, on chain.
 *
 * Balances are read from the associated token accounts rather than from
 * anything a caller supplies, because these numbers size trades. A holding a
 * user claims is a hint; a holding the chain reports is a fact, and only the
 * second one can be sold.
 */

import { Hono } from "hono";
import { UNIVERSE, bySymbol, driftExceeded, sectorExposure, type Weight } from "@ps/core";
import { getSellableBalances, getSpendable } from "@ps/tx";
import type { Services } from "./context.ts";
import { requireBase58Address } from "./validate.ts";
import type { MarketSnapshot } from "@ps/indexer/snapshot.ts";

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

/**
 * Build a portfolio view from chain balances and a market snapshot.
 *
 * Kept separate from the route so the copy-trading preview can reuse it
 * without going through HTTP.
 */
export async function readPortfolio(
  services: Services,
  owner: string,
  snapshot: MarketSnapshot,
): Promise<{
  readonly owner: string;
  readonly positions: PortfolioPosition[];
  readonly totalUsd: number;
  readonly unpriced: string[];
  readonly usdcUsd: number;
  readonly solLamports: number;
  readonly weights: Weight[];
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

  const [balances, spendable] = await Promise.all([
    getSellableBalances(services.rpc, owner, scaleConfig, snapshot.unixSeconds),
    getSpendable(services.rpc, owner),
  ]);

  const positions: PortfolioPosition[] = [];
  const unpriced: string[] = [];
  let totalUsd = 0;

  for (const token of UNIVERSE) {
    const balance = balances.get(token.symbol);
    // A zero balance is not a position; listing all eight would bury the
    // ones that matter.
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

  // Weights are a share of priced value, so an unpriced position is left
  // null rather than diluting everything else against a total it is not in.
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
  };
}

export function registerPortfolioRoutes(
  app: Hono,
  services: Services,
  market: () => Promise<MarketSnapshot>,
): void {
  /**
   * A wallet's live position.
   *
   * `compare` measures it against a saved strategy, which is what turns the
   * page from a balance list into "am I still holding what I meant to".
   */
  app.get("/api/portfolio/:wallet", async (c) => {
    const owner = requireBase58Address(c.req.param("wallet"), "wallet");
    const snapshot = await market();
    const portfolio = await readPortfolio(services, owner, snapshot);

    const compareId = c.req.query("compare");
    let comparison: unknown = null;
    if (compareId) {
      const strategy = services.store.getStrategy(compareId);
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
        // Surfaced because a wallet with no lamports cannot submit anything,
        // however much it holds.
        canPayFees: portfolio.solLamports >= 3_000_000,
      },
      positions: portfolio.positions,
      sectors: Object.fromEntries(sectorExposure(portfolio.weights)),
      // Non-empty means some position could not be valued, so totalUsd and
      // every weight understate the portfolio.
      unpriced: portfolio.unpriced,
      frozen: portfolio.positions.filter((p) => p.frozen).map((p) => p.symbol),
      comparison,
    });
  });

  /** Holdings for one symbol, for an asset page. */
  app.get("/api/portfolio/:wallet/:symbol", async (c) => {
    const owner = requireBase58Address(c.req.param("wallet"), "wallet");
    const token = bySymbol(c.req.param("symbol"));
    if (!token) return c.json({ error: "unknown symbol" }, 404);

    const snapshot = await market();
    const portfolio = await readPortfolio(services, owner, snapshot);
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
