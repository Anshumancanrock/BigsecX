/**
 * Response shapes, kept apart from internal types so a refactor does not change
 * the API contract. Nulls are preserved: a missing mark price means the issuer
 * published none, which a client must show as unknown rather than zero.
 */

import type { TokenMeta } from "./meta.ts";
import type { MarketSnapshot, TokenView } from "@ps/market";

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

/**
 * The /api/market response.
 *
 * @param change24h 24-hour change per symbol in percent, from recorded prices.
 *   Replaces the aggregator's figure, which swings widely on markets this thin.
 */
export function toMarketDto(
  snapshot: MarketSnapshot,
  change24h: ReadonlyMap<string, number> = new Map(),
  /** Logo, holders and the day's volume per symbol; absent fields are null. */
  meta: ReadonlyMap<string, TokenMeta> = new Map(),
) {
  return {
    takenAt: snapshot.takenAt.toISOString(),
    epoch: snapshot.epoch,
    tokens: snapshot.tokens.map((view) => {
      const dto = toTokenDto(view);
      const own = change24h.get(view.token.symbol);
      const facts = meta.get(view.token.symbol);
      return {
        ...dto,
        ...(own === undefined ? {} : { change24hPct: own }),
        iconUrl: facts?.iconUrl ?? null,
        holders: facts?.holders ?? null,
        volume24hUsd: facts?.volume24hUsd ?? null,
        traders24h: facts?.traders24h ?? null,
        verified: facts?.verified ?? false,
      };
    }),
    totalLiquidityUsd: snapshot.totalLiquidityUsd,
    pendingFeeChange: snapshot.pendingFeeChange,
    degraded: snapshot.degraded,
    priceFeedError: snapshot.priceFeedError,
    // Issuer powers every holder is exposed to, stated on every market response.
    disclosures: [
      "Each mint has a permanent delegate that can transfer holders' tokens without consent.",
      "Each mint has a freeze authority that can immobilise any account.",
      "Transfers can be paused for all holders at once.",
      "The transfer fee is set by the issuer and can change at an epoch boundary.",
    ],
  };
}
