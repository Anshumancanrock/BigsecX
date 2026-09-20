/**
 * Shapes returned to clients.
 *
 * Deliberately separate from the internal types. A response format is a
 * contract with a frontend; letting it track internal refactors by accident
 * breaks callers for no reason.
 *
 * Nulls are preserved rather than coerced. A missing mark price means the
 * issuer published none, and a UI needs to render that as unknown rather than
 * as zero or as fair value.
 */

import type { MarketSnapshot, TokenView } from "@ps/indexer/snapshot.ts";

export interface TokenDto {
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  readonly sectors: readonly string[];
  readonly marketUsd: number | null;
  readonly markUsd: number | null;
  readonly basis: number | null;
  readonly basisLabel: string | null;
  readonly liquidityUsd: number;
  readonly change24hPct: number;
  readonly supplyUi: number;
  readonly multiplier: number;
  readonly transferFeeBps: number;
  readonly paused: boolean;
  /** What the issuer can do to a holder's tokens. */
  readonly issuerControl: {
    readonly permanentDelegate: string | null;
    readonly freezeAuthority: string | null;
    readonly transferHookProgramId: string | null;
  };
}

export function toTokenDto(view: TokenView): TokenDto {
  return {
    symbol: view.token.symbol,
    name: view.token.name,
    mint: view.token.mint,
    sectors: view.token.sectors,
    marketUsd: view.marketUsd,
    markUsd: view.markUsd,
    basis: view.basis,
    basisLabel: view.basisLabel,
    liquidityUsd: view.liquidityUsd,
    change24hPct: view.change24hPct,
    supplyUi: view.supplyUi,
    multiplier: view.multiplier,
    transferFeeBps: view.transferFeeBps,
    paused: view.paused,
    issuerControl: view.issuerControl,
  };
}

export function toMarketDto(snapshot: MarketSnapshot) {
  return {
    takenAt: snapshot.takenAt.toISOString(),
    epoch: snapshot.epoch,
    tokens: snapshot.tokens.map(toTokenDto),
    totalLiquidityUsd: snapshot.totalLiquidityUsd,
    pendingFeeChange: snapshot.pendingFeeChange,
    degraded: snapshot.degraded,
    priceFeedError: snapshot.priceFeedError,
    // Stated on every market response rather than buried in documentation.
    // These are not our powers, but a user trading through us is exposed to
    // them and has no other way to learn of them from this API.
    disclosures: [
      "Each mint has a permanent delegate that can transfer holders' tokens without consent.",
      "Each mint has a freeze authority that can immobilise any account.",
      "Transfers can be paused for all holders at once.",
      "The transfer fee is set by the issuer and can change at an epoch boundary.",
    ],
  };
}
