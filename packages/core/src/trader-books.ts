/**
 * A wallet's trades per company (what it put in, took out, and how long it
 * held), for profiles. The rules match `computeTraderPnl`: only trades seen
 * since indexing began count, and a book with a gap is marked incomplete.
 */

import { believableCost } from "./trader-pnl.ts";

export interface TimedTrade {
  readonly symbol: string;
  /** Signed share change. Positive is a buy. */
  readonly uiAmount: number;
  /** Signed USD value. Positive is money spent. Null when unpriced. */
  readonly valueUsd: number | null;
  readonly slot: number;
  /** Unix seconds; null when the node did not report it. */
  readonly blockTime: number | null;
}

export interface SymbolBook {
  readonly symbol: string;
  /** Shares held, by the trades seen. */
  readonly uiAmount: number;
  readonly boughtUsd: number;
  readonly soldUsd: number;
  /** Money put in less money taken out, for this company alone. */
  readonly netInvestedUsd: number;
  /**
   * False when a trade had no believable cost, or when shares were sold
   * that were never seen bought. Either way the money figures are partial.
   */
  readonly complete: boolean;
  /** Back to nothing after holding some. */
  readonly closed: boolean;
  readonly trades: number;
  readonly firstAt: number | null;
  readonly lastAt: number | null;
}

/** Below this a share count is rounding, not a position. */
const DUST = 1e-9;

export function symbolBooks(
  trades: readonly TimedTrade[],
  priceBySymbol: ReadonlyMap<string, number>,
): SymbolBook[] {
  interface Running {
    uiAmount: number;
    lowest: number;
    boughtUsd: number;
    soldUsd: number;
    unpriced: boolean;
    held: boolean;
    trades: number;
    firstAt: number | null;
    lastAt: number | null;
  }
  const books = new Map<string, Running>();

  for (const group of bySlot(trades)) {
    const first = group[0]!;
    const book =
      books.get(first.symbol) ??
      ({
        uiAmount: 0,
        lowest: 0,
        boughtUsd: 0,
        soldUsd: 0,
        unpriced: false,
        held: false,
        trades: 0,
        firstAt: null,
        lastAt: null,
      } satisfies Running);
    books.set(first.symbol, book);

    // Trade order within a slot is not recorded, so apply the slot's net;
    // trade by trade could open or close a position that net never did.
    book.uiAmount += group.reduce((sum, t) => sum + t.uiAmount, 0);
    book.lowest = Math.min(book.lowest, book.uiAmount);
    if (book.uiAmount > DUST) book.held = true;

    for (const trade of group) {
      book.trades++;
      if (trade.blockTime !== null) {
        book.firstAt ??= trade.blockTime;
        book.lastAt = trade.blockTime;
      }
      if (trade.valueUsd === null || !believableCost(trade, priceBySymbol.get(trade.symbol))) {
        book.unpriced = true;
        continue;
      }
      if (trade.valueUsd > 0) book.boughtUsd += trade.valueUsd;
      else book.soldUsd += -trade.valueUsd;
    }
  }

  return [...books].map(([symbol, book]) => ({
    symbol,
    uiAmount: Math.abs(book.uiAmount) < DUST ? 0 : book.uiAmount,
    boughtUsd: book.boughtUsd,
    soldUsd: book.soldUsd,
    netInvestedUsd: book.boughtUsd - book.soldUsd,
    complete: !book.unpriced && book.lowest >= -DUST,
    closed: book.held && book.uiAmount <= DUST,
    trades: book.trades,
    firstAt: book.firstAt,
    lastAt: book.lastAt,
  }));
}

/**
 * How long this wallet keeps what it buys, on average, in seconds.
 *
 * A hold runs from a position rising above zero until it returns to zero, or
 * to `nowSeconds` if still open; top-ups and trims do not start a new hold.
 * Null when there is no hold to measure: no buys seen, or none with a time.
 */
export function averageHoldSeconds(trades: readonly TimedTrade[], nowSeconds: number): number | null {
  const quantity = new Map<string, number>();
  // Undefined while flat; null when the hold began at an unknown time.
  const openedAt = new Map<string, number | null>();
  const holds: number[] = [];

  // Net each slot first, as in `symbolBooks`: order within a slot is unknown.
  for (const group of bySlot(trades)) {
    const symbol = group[0]!.symbol;
    const at = group.find((t) => t.blockTime !== null)?.blockTime ?? null;
    const before = quantity.get(symbol) ?? 0;
    const after = before + group.reduce((sum, t) => sum + t.uiAmount, 0);
    quantity.set(symbol, after);
    if (before <= DUST && after > DUST) {
      openedAt.set(symbol, at);
    } else if (before > DUST && after <= DUST) {
      const opened = openedAt.get(symbol);
      if (opened != null && at !== null) holds.push(Math.max(0, at - opened));
      openedAt.delete(symbol);
    }
  }
  for (const [symbol, amount] of quantity) {
    const opened = openedAt.get(symbol);
    if (amount > DUST && opened != null) holds.push(Math.max(0, nowSeconds - opened));
  }

  if (holds.length === 0) return null;
  return holds.reduce((sum, h) => sum + h, 0) / holds.length;
}

/** Trades grouped by company and slot, slots in order. */
function bySlot(trades: readonly TimedTrade[]): TimedTrade[][] {
  const groups = new Map<string, TimedTrade[]>();
  for (const trade of trades) {
    const key = `${trade.slot}:${trade.symbol}`;
    const group = groups.get(key);
    if (group) group.push(trade);
    else groups.set(key, [trade]);
  }
  return [...groups.values()].sort((a, b) => a[0]!.slot - b[0]!.slot);
}
