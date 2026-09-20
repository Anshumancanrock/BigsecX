/**
 * Jupiter client.
 *
 * Endpoint status as measured on 2026-09-19:
 *   https://lite-api.jup.ag/swap/v1/quote   works, keyless, tightly rate limited
 *   https://api.jup.ag/swap/v1/quote        works, same shape (key for volume)
 *   https://quote-api.jup.ag/v6/quote       DEAD, connection fails
 *
 * The single most important fact about this API for PreStocks: quote amounts
 * are RAW base units and take no account of the ScaledUiAmount multiplier.
 * Price v3 is different -- its `usdPrice` IS multiplier-corrected, and it
 * exposes the uncorrected figure separately as `usdPricePrescaled`. Mixing the
 * two up is how an app ends up showing SPACEX at five times its real price.
 */

import { Cache, RateLimiter, getJson } from "./http.ts";

const LITE = "https://lite-api.jup.ag";

/** One venue hop inside a route. */
export interface RouteStep {
  readonly swapInfo: {
    readonly ammKey: string;
    readonly label: string;
    readonly inputMint: string;
    readonly outputMint: string;
    readonly inAmount: string;
    readonly outAmount: string;
  };
  readonly percent: number;
}

export interface Quote {
  readonly inputMint: string;
  readonly outputMint: string;
  /** Raw base units. */
  readonly inAmount: string;
  /** Raw base units. NOT multiplier-adjusted, and NOT net of transfer fee. */
  readonly outAmount: string;
  readonly otherAmountThreshold: string;
  readonly swapMode: "ExactIn" | "ExactOut";
  readonly slippageBps: number;
  readonly priceImpactPct: string;
  readonly routePlan: readonly RouteStep[];
  readonly contextSlot: number;
  readonly swapUsdValue?: string;
}

/** Price v3 entry. */
export interface PriceEntry {
  readonly usdPrice: number;
  readonly decimals: number;
  readonly blockId: number;
  readonly priceChange24h: number;
  readonly liquidity: number;
  /** Issuer mark data, echoed by Jupiter for tokenized-stock mints. */
  readonly stockData?: {
    readonly id: string;
    readonly price: number;
    readonly mcap: number;
    readonly updatedAt: string;
  };
  /** Present only on mints carrying the ScaledUiAmount extension. */
  readonly scaledUiConfig?: {
    readonly multiplier: number;
    readonly newMultiplier: number;
    readonly newMultiplierEffectiveAt: string;
    readonly circSupplyPrescaled: number;
    readonly totalSupplyPrescaled: number;
    /** The price before multiplier correction. Never show this to a user. */
    readonly usdPricePrescaled: number;
  };
}

export interface QuoteRequest {
  readonly inputMint: string;
  readonly outputMint: string;
  /** Raw base units of the input mint. */
  readonly amount: bigint;
  readonly slippageBps?: number;
  readonly swapMode?: "ExactIn" | "ExactOut";
  /** Restricting to direct routes lowers the account count in the built tx. */
  readonly onlyDirectRoutes?: boolean;
  /**
   * Cap the accounts a route may touch.
   *
   * The binding constraint on a basket is the 1232-byte transaction, and a
   * multi-hop PreStocks route can need 1335 bytes on its own. Constraining the
   * route at quote time is the supported way to keep it executable; the
   * alternative, discovering it does not fit after building, wastes a quote
   * and often has no remedy.
   */
  readonly maxAccounts?: number;
  /**
   * Venue labels to route around, as they appear in `routePlan[].swapInfo.label`.
   *
   * Used to retry a leg whose chosen venue rejected the swap in simulation.
   * Some PreStocks venues fail on sizes or states the quote does not predict,
   * and routing around one is far better than dropping the leg.
   */
  readonly excludeDexes?: readonly string[];
}

export class JupiterClient {
  readonly #cache = new Cache();
  // Observed headers reported a remaining quota in single digits, so this is
  // deliberately conservative. Raise it only alongside an API key.
  readonly #limiter = new RateLimiter(4, 1);

  constructor(private readonly base: string = LITE) {}

  /**
   * Prices for many mints in one call.
   *
   * `usdPrice` here is already corrected for the scale multiplier, which makes
   * this the cheapest correct price source we have. It also returns the issuer
   * mark under `stockData.price` and real quotable liquidity, so a single
   * request covers market price, mark price, and depth.
   */
  prices(mints: readonly string[], ttlMs = 15_000): Promise<Record<string, PriceEntry>> {
    const ids = [...mints].sort().join(",");
    return this.#cache.fetch(`price:${ids}`, ttlMs, () =>
      getJson<Record<string, PriceEntry>>(`${this.base}/price/v3?ids=${ids}`, {
        upstream: "jupiter-price",
        limiter: this.#limiter,
      }),
    );
  }

  /**
   * Quote a swap.
   *
   * Cached briefly and keyed on every input: quoting is the hottest path in the
   * app and the rate limit is the binding constraint, not latency.
   */
  quote(request: QuoteRequest, ttlMs = 5_000): Promise<Quote> {
    const params = new URLSearchParams({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      amount: request.amount.toString(),
      slippageBps: String(request.slippageBps ?? 100),
      swapMode: request.swapMode ?? "ExactIn",
    });
    if (request.onlyDirectRoutes) params.set("onlyDirectRoutes", "true");
    if (request.maxAccounts !== undefined) params.set("maxAccounts", String(request.maxAccounts));
    if (request.excludeDexes?.length) params.set("excludeDexes", request.excludeDexes.join(","));

    const url = `${this.base}/swap/v1/quote?${params.toString()}`;
    return this.#cache.fetch(`quote:${params.toString()}`, ttlMs, () =>
      getJson<Quote>(url, { upstream: "jupiter-quote", limiter: this.#limiter }),
    );
  }
}

export interface SwapInstructionsOptions {
  readonly userPublicKey: string;
  readonly wrapAndUnwrapSol?: boolean;
  readonly dynamicComputeUnitLimit?: boolean;
  /** Reuse an existing wrapped-SOL account instead of creating one per swap. */
  readonly useSharedAccounts?: boolean;
}

/** Shared budget for instruction building, separate from quoting. */
const SWAP_LIMITER = new RateLimiter(4, 1);

export class JupiterSwapError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "JupiterSwapError";
  }
}

/**
 * Ask Jupiter for the raw instructions behind a quote.
 *
 * Preferred over `/swap`, which returns a finished transaction: a basket needs
 * several swaps packed together, and that is only possible with the
 * instructions in hand. The response also carries
 * `addressesByLookupTableAddress`, so the lookup tables come back inline
 * rather than costing an RPC call each.
 *
 * Deliberately not cached. These are signed and broadcast, and a stale
 * instruction set would route against prices that have moved.
 */
export async function fetchSwapInstructions<T>(
  quote: Quote,
  options: SwapInstructionsOptions,
  base: string = LITE,
  limiter: RateLimiter = SWAP_LIMITER,
): Promise<T> {
  // Shares the same budget discipline as quoting. Building an eight-leg
  // basket issues eight of these back to back, which is enough to draw a 429
  // on its own.
  await limiter.acquire();

  const response = await fetch(`${base}/swap/v1/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: options.userPublicKey,
      wrapAndUnwrapSol: options.wrapAndUnwrapSol ?? true,
      dynamicComputeUnitLimit: options.dynamicComputeUnitLimit ?? true,
      useSharedAccounts: options.useSharedAccounts ?? true,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new JupiterSwapError(
      `swap-instructions failed: HTTP ${response.status} ${await response.text()}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

/** Venue labels seen carrying PreStocks flow, from live route plans. */
export function venues(quote: Quote): readonly string[] {
  return quote.routePlan.map((step) => step.swapInfo.label);
}

/** Price impact as a fraction. Jupiter returns it as a decimal string. */
export function priceImpact(quote: Quote): number {
  return Number(quote.priceImpactPct);
}
