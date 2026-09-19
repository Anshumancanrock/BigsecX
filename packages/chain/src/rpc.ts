/**
 * Minimal Solana JSON-RPC client.
 *
 * Reads only. The whole read path deliberately avoids @solana/web3.js: for
 * fetching parsed mint and token-account state the library buys nothing over
 * `fetch`, and it drags in a dependency whose major versions have churned. The
 * signing path, where the library does earn its weight, lives in the frontend.
 */

export interface RpcError {
  readonly code: number;
  readonly message: string;
}

export class RpcFailure extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: RpcError | null,
    message: string,
  ) {
    super(message);
    this.name = "RpcFailure";
  }
}

export interface RpcOptions {
  readonly url: string;
  /** Requests are retried on 429 and 5xx with exponential backoff. */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export class Rpc {
  #id = 0;
  readonly #url: string;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;

  constructor(options: RpcOptions) {
    this.#url = options.url;
    this.#maxRetries = options.maxRetries ?? 4;
    this.#timeoutMs = options.timeoutMs ?? 45_000;
  }

  /**
   * POST a payload with retry on the statuses public endpoints use to shed
   * load. Shared by single and batch calls so both get the same treatment --
   * a batch is exactly as likely to be rate limited as a call.
   */
  async #send(label: string, body: string): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));

      try {
        const response = await fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        // Public endpoints rate limit hard; treat that as retryable.
        if (response.status === 429 || response.status >= 500) {
          lastError = new RpcFailure(label, null, `HTTP ${response.status}`);
          continue;
        }
        if (!response.ok) throw new RpcFailure(label, null, `HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        if (error instanceof RpcFailure && error.rpcError) throw error;
        lastError = error as Error;
      }
    }
    throw new RpcFailure(label, null, `${label} failed after retries: ${lastError?.message}`);
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params });
    const json = (await this.#send(method, body)) as { result?: T; error?: RpcError };
    if (json.error) {
      throw new RpcFailure(method, json.error, `${method}: ${json.error.message}`);
    }
    return json.result as T;
  }

  /** Batch several calls into one HTTP request. */
  async batch<T>(calls: readonly { method: string; params?: unknown[] }[]): Promise<T[]> {
    if (calls.length === 0) return [];
    const payload = calls.map((c) => ({
      jsonrpc: "2.0",
      id: ++this.#id,
      method: c.method,
      params: c.params ?? [],
    }));

    const results = (await this.#send(
      `batch(${calls[0]?.method ?? "?"} x${calls.length})`,
      JSON.stringify(payload),
    )) as { id: number; result?: T; error?: RpcError }[];
    // Batch responses may arrive out of order; restore the request order.
    const byId = new Map(results.map((r) => [r.id, r]));
    return payload.map((p) => {
      const entry = byId.get(p.id);
      if (!entry || entry.error) {
        throw new RpcFailure(p.method, entry?.error ?? null, `batch item ${p.method} failed`);
      }
      return entry.result as T;
    });
  }

  async epoch(): Promise<number> {
    const info = await this.call<{ epoch: number }>("getEpochInfo");
    return info.epoch;
  }

  async blockTime(): Promise<number> {
    const slot = await this.call<number>("getSlot");
    const time = await this.call<number | null>("getBlockTime", [slot]);
    return time ?? Math.floor(Date.now() / 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
