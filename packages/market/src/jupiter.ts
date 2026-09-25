/**
 * Jupiter client. Quote amounts are raw base units that ignore the
 * ScaledUiAmount multiplier, while Price v3 `usdPrice` is multiplier-corrected
 * (`usdPricePrescaled` is not). The quote-api.jup.ag/v6 host is offline.
 */

import { Cache, RateLimiter, getJson } from "./http.ts";

const LITE = "https://lite-api.jup.ag";
/** Keyed tier. Same paths, far higher limits. */
const PRO = "https://api.jup.ag";

/**
 * Base URL and auth header from the environment. JUPITER_API_KEY moves every
 * call to the keyed host; without it the keyless rate limit dominates build
 * time (an eight-leg basket needs sixteen quotes and eight instruction fetches).
 */
export function jupiterTransport(): { base: string; headers: Record<string, string> } {
  const key = process.env["JUPITER_API_KEY"];
  return key
    ? { base: PRO, headers: { "x-api-key": key } }
    : { base: LITE, headers: {} };
}

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
  /**
   * Raw base units, not multiplier-adjusted. Net of the Token-2022 transfer fee
   * on some routes and not others.
   */
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
    /** Price before multiplier correction; not for display. */
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
   * Caps the accounts a route may touch. A multi-hop PreStocks route can need
   * 1335 bytes against the 1232-byte transaction limit.
   */
  readonly maxAccounts?: number;
  /**
   * Venue labels to route around, as in `routePlan[].swapInfo.label`. Used to
   * retry a leg whose venue failed simulation on a size or state the quote did
   * not predict.
   */
  readonly excludeDexes?: readonly string[];
}

export class JupiterClient {
  readonly #cache = new Cache();
  readonly #limiter: RateLimiter;
  readonly #headers: Record<string, string>;
  private readonly base: string;

  /**
   * The keyless host accepts bursts of about 30 concurrent quotes; 24 covers a
   * basket's sizing and build quotes plus re-quotes. A 429 still backs off and
   * retries.
   */
  constructor(base?: string) {
    const transport = jupiterTransport();
    this.base = base ?? transport.base;
    this.#headers = transport.headers;
    const keyed = Object.keys(transport.headers).length > 0;
    this.#limiter = keyed ? new RateLimiter(40, 20) : new RateLimiter(24, 6);
  }

  /**
   * Price v3 for many mints in one call: multiplier-corrected `usdPrice`, the
   * issuer mark under `stockData.price`, and quotable liquidity.
   */
  prices(mints: readonly string[], ttlMs = 15_000): Promise<Record<string, PriceEntry>> {
    const ids = [...mints].sort().join(",");
    return this.#cache.fetch(`price:${ids}`, ttlMs, () =>
      getJson<Record<string, PriceEntry>>(`${this.base}/price/v3?ids=${ids}`, {
        upstream: "jupiter-price",
        limiter: this.#limiter,
        headers: this.#headers,
      }),
    );
  }

  /**
   * Quotes a swap. Cached briefly and keyed on every parameter, since the rate
   * limit rather than latency is the binding constraint.
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
      getJson<Quote>(url, {
        upstream: "jupiter-quote",
        limiter: this.#limiter,
        headers: this.#headers,
      }),
    );
  }
}

export interface SwapInstructionsOptions {
  readonly userPublicKey: string;
  readonly wrapAndUnwrapSol?: boolean;
  readonly dynamicComputeUnitLimit?: boolean;
  /** Use Jupiter's shared program accounts instead of creating intermediate token accounts. */
  readonly useSharedAccounts?: boolean;
}

/**
 * Budget for instruction fetches, separate from quoting. A burst of 12 covers
 * an eight-leg basket plus legs that fall back to a narrower route.
 */
const SWAP_LIMITER = new RateLimiter(12, 4);

export class JupiterSwapError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "JupiterSwapError";
  }
}

/**
 * Fetches the instructions behind a quote. Used instead of `/swap`, which
 * returns a finished transaction, so several swaps can share one transaction.
 * Not cached, since the result is signed and broadcast.
 */
export async function fetchSwapInstructions<T>(
  quote: Quote,
  options: SwapInstructionsOptions,
  base?: string,
  limiter: RateLimiter = SWAP_LIMITER,
): Promise<T> {
  const transport = jupiterTransport();
  const host = base ?? transport.base;
  const body = JSON.stringify({
    quoteResponse: quote,
    userPublicKey: options.userPublicKey,
    wrapAndUnwrapSol: options.wrapAndUnwrapSol ?? true,
    dynamicComputeUnitLimit: options.dynamicComputeUnitLimit ?? true,
    useSharedAccounts: options.useSharedAccounts ?? true,
  });

  // 429 and 5xx are retried like getJson, so a transient rate limit does not
  // use up a rung of the route ladder.
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * 2 ** (attempt - 1)));
    await limiter.acquire();

    try {
      const response = await fetch(`${host}/swap/v1/swap-instructions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...transport.headers,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) return (await response.json()) as T;

      const text = await response.text();
      if (response.status !== 429 && response.status < 500) {
        // A rejected route is final; retrying it wastes the budget.
        throw new JupiterSwapError(
          `swap-instructions failed: HTTP ${response.status} ${text}`,
          response.status,
        );
      }
      lastError = new JupiterSwapError(`HTTP ${response.status} ${text}`, response.status);
    } catch (error) {
      if (error instanceof JupiterSwapError && error.status !== null && error.status < 500 && error.status !== 429) {
        throw error;
      }
      lastError = error as Error;
    }
  }
  throw new JupiterSwapError(
    `swap-instructions failed after ${maxRetries} retries: ${lastError?.message}`,
    null,
  );
}

/** Venue labels in a quote's route plan. */
export function venues(quote: Quote): readonly string[] {
  return quote.routePlan.map((step) => step.swapInfo.label);
}

/** Price impact as a fraction. Jupiter returns it as a decimal string. */
export function priceImpact(quote: Quote): number {
  return Number(quote.priceImpactPct);
}
