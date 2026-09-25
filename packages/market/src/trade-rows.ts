/**
 * Trade rows as stored: shares in UI units and a USD cost from the stablecoin
 * or SOL that moved. Shared by the indexer and the API's record route so a
 * trade seen by both produces the same row.
 */

import { byMint, rawToUi } from "@ps/core";
import type { MintState, Trade } from "@ps/chain";

const USDC_DECIMALS = 6;
const WSOL_DECIMALS = 9;
const LAMPORTS_PER_SOL = 1_000_000_000;
/**
 * Native-SOL movements up to this size (0.005 SOL) are account rent, not trade
 * value: opening or closing an ATA moves about 0.00204 SOL.
 */
const MIN_LAMPORT_TRADE = 5_000_000;

/** Same shape as the database's TradeRow. */
export interface TradeRowData {
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

/**
 * USD cost of a trade from the USDC, wrapped SOL or native SOL that moved in
 * the transaction; positive is money spent. Null when no such leg can be valued
 * (e.g. a plain transfer). Marking shares at a current price instead would give a buy
 * and its later sell the same price and erase profit.
 */
export function tradeValueUsd(
  usdcDeltaRaw: bigint | null,
  wsolDeltaRaw: bigint | null,
  lamportDeltaRaw: bigint | null,
  solUsd: number | null,
): number | null {
  if (usdcDeltaRaw !== null && usdcDeltaRaw !== 0n) {
    return -Number(usdcDeltaRaw) / 10 ** USDC_DECIMALS;
  }
  // Most routes hop through SOL rather than USDC. The SOL amount is what moved
  // in this transaction; only the SOL/USD rate is current, and that pair moves
  // far less than these tokens.
  if (wsolDeltaRaw !== null && wsolDeltaRaw !== 0n && solUsd !== null && solUsd > 0) {
    return (-Number(wsolDeltaRaw) / 10 ** WSOL_DECIMALS) * solUsd;
  }
  // Native lamports last, and only above rent size. Jupiter wraps and unwraps
  // SOL within the transaction, so a SOL-routed swap leaves no wrapped-SOL
  // delta and its cost appears only here.
  if (
    lamportDeltaRaw !== null &&
    solUsd !== null &&
    solUsd > 0 &&
    (lamportDeltaRaw > BigInt(MIN_LAMPORT_TRADE) || lamportDeltaRaw < BigInt(-MIN_LAMPORT_TRADE))
  ) {
    return (-Number(lamportDeltaRaw) / LAMPORTS_PER_SOL) * solUsd;
  }
  return null;
}

/**
 * Converts parsed trades into rows. Trades in mints outside the universe or
 * without readable mint state are skipped, since their shares cannot be scaled.
 */
export function tradeRows(
  trades: readonly Trade[],
  mintStates: ReadonlyMap<string, MintState>,
  unixSeconds: number,
  solUsd: number | null,
): TradeRowData[] {
  const rows: TradeRowData[] = [];
  for (const trade of trades) {
    const token = byMint(trade.mint);
    const mintState = mintStates.get(trade.mint);
    if (!token || !mintState) continue;

    // rawToUi takes an unsigned amount, so scale the magnitude and reapply the sign.
    const magnitude = trade.deltaRaw < 0n ? -trade.deltaRaw : trade.deltaRaw;
    const uiMagnitude = rawToUi(magnitude, mintState.decimals, mintState.scale, unixSeconds);
    rows.push({
      signature: trade.signature,
      owner: trade.owner,
      symbol: token.symbol,
      slot: trade.slot,
      blockTime: trade.blockTime,
      deltaRaw: trade.deltaRaw,
      uiAmount: trade.deltaRaw < 0n ? -uiMagnitude : uiMagnitude,
      valueUsd: tradeValueUsd(trade.usdcDeltaRaw, trade.wsolDeltaRaw, trade.lamportDeltaRaw, solUsd),
    });
  }
  return rows;
}
