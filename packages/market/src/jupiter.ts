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

    const url = `${this.base}/swap/v1/quote?${params.toString()}`;
    return this.#cache.fetch(`quote:${params.toString()}`, ttlMs, () =>
      getJson<Quote>(url, { upstream: "jupiter-quote", limiter: this.#limiter }),
    );
  }
}

/** Venue labels seen carrying PreStocks flow, from live route plans. */
export function venues(quote: Quote): readonly string[] {
  return quote.routePlan.map((step) => step.swapInfo.label);
}

/** Price impact as a fraction. Jupiter returns it as a decimal string. */
export function priceImpact(quote: Quote): number {
  return Number(quote.priceImpactPct);
}
