export interface RpcError {
  readonly code: number;
  readonly message: string;
  /**
   * Whatever the node attached; untyped because it differs per method. For a
   * failed preflight it holds `{err, logs, unitsConsumed}`, and the logs are
   * the only record of why the transaction would not land.
   */
  readonly data?: unknown;
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

export const PUBLIC_RPC_URLS: readonly string[] = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

export function rpcUrls(value: string | readonly string[]): string[] {
  const list = typeof value === "string" ? value.split(",") : [...value];
  return [...new Set(list.map((url) => url.trim()).filter(Boolean))];
}

export interface RpcOptions {
  readonly url: string | readonly string[];
  /** Requests are retried on 429, 5xx and network failures, with backoff. */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly cooldownMs?: number;
}

export class Rpc {
  #id = 0;
  readonly #urls: readonly string[];
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #cooldownMs: number;
  readonly #restingUntil = new Map<string, number>();
  readonly #refusals = new Map<string, number>();

  constructor(options: RpcOptions) {
    this.#urls = rpcUrls(options.url);
    if (this.#urls.length === 0) throw new Error("Rpc needs at least one endpoint URL");
    this.#maxRetries = options.maxRetries ?? 4;
    this.#timeoutMs = options.timeoutMs ?? 45_000;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
  }

  async #send(label: string, body: string): Promise<unknown> {
    let lastError: Error | null = null;
    const refused = new Map<string, RpcFailure>();
    // Endpoints tried since the last pause.
    const tried = new Set<string>();
    let pauses = 0;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const open = this.#urls.filter((url) => !refused.has(url));
      if (open.length === 0) break;
      let url = this.#pick(open, tried, label);
      if (url === null) {
        await sleep(400 * 2 ** pauses++);
        tried.clear();
        url = this.#pick(open, tried, label)!;
      }
      tried.add(url);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        if (response.status === 429 || response.status >= 500) {
          this.#rest(url);
          lastError = new RpcFailure(label, null, `HTTP ${response.status}`);
          continue;
        }
        if (!response.ok) {
          let refusal: RpcError = { code: response.status, message: `HTTP ${response.status}` };
          try {
            const body = (await response.json()) as { error?: RpcError };
            if (body?.error?.message) refusal = body.error;
          } catch {
            // Not JSON; the status is all there is.
          }
          refused.set(url, new RpcFailure(label, refusal, `${label}: ${refusal.message}`));
          this.#refusals.set(`${url} ${label}`, Date.now() + REFUSAL_MEMORY_MS);
          continue;
        }
        const json = await response.json();
        this.#restingUntil.delete(url);
        return json;
      } catch (error) {
        // Dropped connection, DNS failure, timeout or non-JSON body: rest this
        // endpoint so the next call starts with another.
        this.#rest(url);
        lastError = error as Error;
      }
    }

    const refusal = refused.values().next().value as RpcFailure | undefined;
    if (refusal && refused.size === this.#urls.length) throw refusal;
    throw new RpcFailure(label, null, `${label} failed after retries: ${lastError?.message ?? refusal?.message}`);
  }

  /**
   * The next endpoint not tried since the last pause. Endpoints that recently
   * refused this method go behind the rest; within each group, recently failed
   * ones go behind healthy ones. Null once all have been tried.
   */
  #pick(open: readonly string[], tried: ReadonlySet<string>, label: string): string | null {
    const untried = open.filter((url) => !tried.has(url));
    if (untried.length === 0) return null;
    const now = Date.now();
    const refusedLately = (url: string) => Number((this.#refusals.get(`${url} ${label}`) ?? 0) > now);
    const resting = (url: string) => Number((this.#restingUntil.get(url) ?? 0) > now);
    return [...untried].sort((a, b) => refusedLately(a) - refusedLately(b) || resting(a) - resting(b))[0]!;
  }

  #rest(url: string): void {
    if (this.#urls.length > 1) this.#restingUntil.set(url, Date.now() + this.#cooldownMs);
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params });
    const json = (await this.#send(method, body)) as { result?: T; error?: RpcError };
    if (json.error) {
      throw new RpcFailure(method, json.error, `${method}: ${json.error.message}`);
    }
    return json.result as T;
  }

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
    // A non-array answer (an error object, a proxy's HTML page) would
    // otherwise throw an uninformative TypeError from .map below.
    if (!Array.isArray(results)) {
      throw new RpcFailure(calls[0]?.method ?? "batch", null, "batch response was not an array");
    }
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

const REFUSAL_MEMORY_MS = 10 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
