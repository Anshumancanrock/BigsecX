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
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params });

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));

      try {
        const response = await fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        // Public endpoints rate limit hard; treat that as retryable.
        if (response.status === 429 || response.status >= 500) {
          lastError = new RpcFailure(method, null, `HTTP ${response.status}`);
          continue;
        }
        if (!response.ok) {
          throw new RpcFailure(method, null, `HTTP ${response.status}`);
        }

        const json = (await response.json()) as { result?: T; error?: RpcError };
        if (json.error) {
          throw new RpcFailure(method, json.error, `${method}: ${json.error.message}`);
        }
        return json.result as T;
      } catch (error) {
        if (error instanceof RpcFailure && error.rpcError) throw error;
        lastError = error as Error;
      }
    }
    throw new RpcFailure(method, null, `${method} failed after retries: ${lastError?.message}`);
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

    const response = await fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new RpcFailure("batch", null, `HTTP ${response.status}`);

    const results = (await response.json()) as {
      id: number;
      result?: T;
      error?: RpcError;
    }[];
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
