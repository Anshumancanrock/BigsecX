/**
 * Fake services for API tests.
 *
 * These stand in for mainnet and the aggregator so every route -- especially
 * the refusal paths -- can be exercised without a network. Hand-fuzzing a
 * running server reaches the happy path and a few 400s; it cannot reliably
 * reproduce an upstream failure, an empty database, or a wallet with exactly
 * the wrong balance.
 */

import { ALL_MINTS, UNIVERSE, type PreStock } from "@ps/core";
import type { Services } from "../src/context.ts";
import { Store } from "@ps/db";

/** Live-shaped multipliers, so scaling bugs surface in tests too. */
export const MULTIPLIERS: Readonly<Record<string, number>> = {
  OPENAI: 1.4861347,
  SPACEX: 5,
};

export const FAKE_EPOCH = 1038;

function mintAccount(token: PreStock) {
  const multiplier = MULTIPLIERS[token.symbol] ?? 1;
  return {
    owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    data: {
      parsed: {
        type: "mint",
        info: {
          decimals: token.decimals,
          supply: "1000000000000",
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [
            {
              extension: "scaledUiAmountConfig",
              state: {
                multiplier: String(multiplier),
                newMultiplier: String(multiplier),
                newMultiplierEffectiveTimestamp: 0,
              },
            },
            {
              extension: "transferFeeConfig",
              state: {
                olderTransferFee: {
                  epoch: 1032,
                  transferFeeBasisPoints: 50,
                  maximumFee: "18446744073709551615",
                },
                newerTransferFee: {
                  epoch: 1039,
                  transferFeeBasisPoints: 100,
                  maximumFee: "18446744073709551615",
                },
              },
            },
            { extension: "pausableConfig", state: { paused: false } },
          ],
        },
      },
      program: "spl-token-2022",
    },
  };
}

export interface FakeOptions {
  /** Raw ATA balances by symbol, for the sell-coverage check. */
  readonly balances?: Readonly<Record<string, bigint>>;
  /** Make the price feed fail, to exercise degraded paths. */
  readonly pricesThrow?: boolean;
  readonly priceUsd?: Readonly<Record<string, number>>;
}

export function fakeRpc(options: FakeOptions = {}) {
  const calls: string[] = [];
  return {
    calls,
    epoch: async () => FAKE_EPOCH,
    blockTime: async () => 1_789_000_000,
    call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
      calls.push(method);

      if (method === "getEpochInfo") return { epoch: FAKE_EPOCH } as T;

      if (method === "getLatestBlockhash") {
        return {
          value: {
            blockhash: "9C62FZuEUbpZmFrqPQbNfBiPr5U1JcTBhCfKqGgSEg4m",
            lastValidBlockHeight: 426_629_512,
          },
        } as T;
      }

      if (method === "getMultipleAccounts") {
        const addresses = params[0] as string[];
        // Mint reads ask by mint address; the balance check asks by ATA.
        const isMintRead = addresses.every((a) => ALL_MINTS.includes(a));
        if (isMintRead) {
          return {
            value: addresses.map((mint) => {
              const token = UNIVERSE.find((t) => t.mint === mint);
              return token ? mintAccount(token) : null;
            }),
          } as T;
        }
        // Balances are returned in universe order, matching how the caller
        // derived the addresses.
        return {
          value: UNIVERSE.map((token) => {
            const raw = options.balances?.[token.symbol];
            if (raw === undefined) return null;
            return {
              data: {
                parsed: { info: { mint: token.mint, tokenAmount: { amount: raw.toString() } } },
              },
            };
          }),
        } as T;
      }

      throw new Error(`fakeRpc: unexpected method ${method}`);
    },
  };
}

export function fakeJupiter(options: FakeOptions = {}) {
  return {
    prices: async (mints: readonly string[]) => {
      if (options.pricesThrow) throw new Error("jupiter: HTTP 429");
      const out: Record<string, unknown> = {};
      for (const mint of mints) {
        const token = UNIVERSE.find((t) => t.mint === mint);
        if (!token) continue;
        const usd = options.priceUsd?.[token.symbol] ?? 100;
        out[mint] = {
          usdPrice: usd,
          decimals: token.decimals,
          blockId: 1,
          priceChange24h: 0,
          liquidity: 500_000,
          stockData: { id: "prestocks", price: usd * 1.05, mcap: 1, updatedAt: "" },
        };
      }
      return out;
    },
    quote: async () => {
      throw new Error("fakeJupiter: quote should not be reached in these tests");
    },
  };
}

let dbCounter = 0;

export function makeServices(options: FakeOptions = {}): Services & { store: Store } {
  // A distinct file per call: tests must not share leaderboard state.
  const store = new Store(`/tmp/ps-api-test-${process.pid}-${dbCounter++}.db`);
  return {
    rpc: fakeRpc(options) as unknown as Services["rpc"],
    jupiter: fakeJupiter(options) as unknown as Services["jupiter"],
    issuer: {} as Services["issuer"],
    store,
  };
}
