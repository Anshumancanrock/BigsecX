/**
 * One consistent view of the market. A snapshot fixes a single timestamp and
 * epoch and derives every figure from them, so a multiplier change or epoch
 * rollover mid-refresh cannot produce figures that disagree.
 */

import {
  ALL_MINTS,
  UNIVERSE,
  basis,
  basisLabel,
  currentMultiplier,
  epochFee,
  pendingFeeChange,
  rawToUi,
  type BasisLabel,
  type PreStock,
} from "@ps/core";
import { getMintStates, type MintState, type Rpc } from "@ps/chain";
import type { JupiterClient, PriceEntry } from "./jupiter.ts";

export interface TokenView {
  readonly token: PreStock;
  /** Multiplier in force at the snapshot timestamp. */
  readonly multiplier: number;
  /** Supply in UI shares. */
  readonly supplyUi: number;
  readonly marketUsd: number | null;
  readonly markUsd: number | null;
  /** Market over mark, as a fraction. Null when the mark is unavailable. */
  readonly basis: number | null;
  readonly basisLabel: BasisLabel | null;
  readonly liquidityUsd: number;
  readonly change24hPct: number;
  /** Transfer fee in force this epoch, in basis points. */
  readonly transferFeeBps: number;
  readonly paused: boolean;
  /**
   * Issuer authorities over this mint, read from chain for disclosure. A
   * permanent delegate can move holders' tokens without consent; a freeze
   * authority can immobilise them.
   */
  readonly issuerControl: {
    readonly permanentDelegate: string | null;
    readonly freezeAuthority: string | null;
    readonly transferHookProgramId: string | null;
  };
}

export interface MarketSnapshot {
  readonly takenAt: Date;
  readonly unixSeconds: number;
  readonly epoch: number;
  readonly tokens: readonly TokenView[];
  readonly totalLiquidityUsd: number;
  /** Set when a transfer fee change is scheduled but not yet live. */
  readonly pendingFeeChange: { readonly fromBps: number; readonly toBps: number; readonly atEpoch: number } | null;
  /** Symbols with missing mint state or prices. */
  readonly degraded: readonly string[];
  /** Set when the price feed failed outright and every price is missing. */
  readonly priceFeedError: string | null;
}

function buildTokenView(
  token: PreStock,
  mint: MintState,
  price: PriceEntry | undefined,
  epoch: number,
  unixSeconds: number,
): TokenView {
  const multiplier = currentMultiplier(mint.scale, unixSeconds);
  const supplyUi = rawToUi(mint.rawSupply, mint.decimals, mint.scale, unixSeconds);

  // Jupiter's usdPrice is already multiplier-corrected; stockData.price is the
  // issuer mark. Both are per UI share, so they are directly comparable.
  const marketUsd = price?.usdPrice ?? null;
  const markUsd = price?.stockData?.price ?? null;

  const basisFraction =
    marketUsd !== null && markUsd !== null && markUsd !== 0 ? marketUsd / markUsd - 1 : null;

  return {
    token,
    multiplier,
    supplyUi,
    marketUsd,
    markUsd,
    basis: basisFraction,
    basisLabel: basisLabel(basisFraction),
    liquidityUsd: price?.liquidity ?? 0,
    change24hPct: price?.priceChange24h ?? 0,
    transferFeeBps: epochFee(mint.transferFee, epoch).transferFeeBasisPoints,
    paused: mint.paused,
    issuerControl: {
      permanentDelegate: mint.permanentDelegate,
      freezeAuthority: mint.freezeAuthority,
      transferHookProgramId: mint.transferHookProgramId,
    },
  };
}

/** Just under the API's snapshot lifetime, so each snapshot asks once. */
const PRICE_TTL_MS = 2_500;

export async function takeSnapshot(
  rpc: Rpc,
  jupiter: JupiterClient,
): Promise<MarketSnapshot> {
  // Every API route depends on a snapshot, so a price feed failure degrades it
  // instead of failing it. Mint state is required: without it the multiplier
  // and fee are unknown and every figure would be wrong.
  const [epoch, mints, priceResult] = await Promise.all([
    rpc.epoch(),
    getMintStates(rpc, ALL_MINTS),
    jupiter.prices(ALL_MINTS, PRICE_TTL_MS).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error as Error }),
    ),
  ]);
  const prices = priceResult.ok ? priceResult.value : {};
  const priceFeedError = priceResult.ok ? null : priceResult.error.message;
  const takenAt = new Date();
  const unixSeconds = Math.floor(takenAt.getTime() / 1000);

  const degraded: string[] = [];
  const tokens: TokenView[] = [];

  for (const token of UNIVERSE) {
    const mint = mints.get(token.mint);
    if (!mint) {
      degraded.push(token.symbol);
      continue;
    }
    const view = buildTokenView(token, mint, prices[token.mint], epoch, unixSeconds);
    if (view.marketUsd === null || view.markUsd === null) degraded.push(token.symbol);
    tokens.push(view);
  }

  // The fee schedule is identical across these mints, so any one will do.
  const anyMint = mints.get(UNIVERSE[0]?.mint ?? "");

  return {
    takenAt,
    unixSeconds,
    epoch,
    tokens,
    totalLiquidityUsd: tokens.reduce((sum, t) => sum + t.liquidityUsd, 0),
    pendingFeeChange: anyMint ? pendingFeeChange(anyMint.transferFee, epoch) : null,
    degraded,
    priceFeedError,
  };
}
