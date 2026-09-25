/**
 * Fake services for the API tests, standing in for mainnet and the aggregator
 * so every route, especially the refusal paths, runs without a network.
 */

import { ALL_MINTS, UNIVERSE, type PreStock } from "@ps/core";
import { Keypair } from "@solana/web3.js";
import { PythClient } from "@ps/market";
import { bodyDigest, canonicalMessage } from "../src/lib/auth.ts";
import type { Services } from "../src/context.ts";
import { Store } from "@ps/db";

/** Live-shaped multipliers, so scaling bugs surface in tests too. */
export const MULTIPLIERS: Readonly<Record<string, number>> = {
  OPENAI: 1.4861347,
  SPACEX: 5,
};

export const FAKE_EPOCH = 1038;

const PAUSED = new Set<string>();

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
            { extension: "pausableConfig", state: { paused: PAUSED.has(token.symbol) } },
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
  readonly usdcRaw?: bigint;
  /** Lamport balance, for the fee check. */
  readonly lamports?: number;
  readonly paused?: readonly string[];
  readonly frozen?: readonly string[];
  readonly pythApiKey?: string;
  readonly statsThrow?: boolean;
  readonly pricesThrow?: boolean;
  readonly priceUsd?: Readonly<Record<string, number>>;
  readonly sendFailsAt?: readonly number[];
  readonly statuses?: Readonly<
    Record<string, { slot: number; confirmationStatus: string | null; err: unknown } | null>
  >;
  readonly blockHeight?: number;
  readonly simFailsAt?: readonly number[];
  readonly priceImpact?: Readonly<Record<string, number>>;
  /**
   * Per-symbol impact that grows with size, as a fraction per dollar: a thin
   * pool where a smaller order really is cheaper. Without it the impact is the
   * same at every size, which models a spread floor.
   */
  readonly impactPerUsd?: Readonly<Record<string, number>>;
  readonly stray?: Readonly<Record<string, readonly bigint[]>>;
  readonly quoteThrows?: boolean;
  /** How many slots the current epoch has left; the fake mints change fee at the next one. */
  readonly slotsLeftInEpoch?: number;
  readonly transactions?: Readonly<Record<string, unknown>>;
  /** Signatures answered null for this many asks first, as a node a moment behind would. */
  readonly lateTransactions?: Readonly<Record<string, number>>;
}

export function fakeRpc(options: FakeOptions = {}) {
  const calls: string[] = [];
  const transactionAsks = new Map<string, number>();
  return {
    calls,
    epoch: async () => FAKE_EPOCH,
    blockTime: async () => 1_789_000_000,
    call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
      calls.push(method);

      if (method === "getEpochInfo") {
        // Early in the epoch unless a test puts the cluster near its end.
        const slotsInEpoch = 432_000;
        const slotsLeft = options.slotsLeftInEpoch ?? 400_000;
        return { epoch: FAKE_EPOCH, slotIndex: slotsInEpoch - slotsLeft, slotsInEpoch } as T;
      }

      if (method === "getBalance") {
        return { value: options.lamports ?? 50_000_000 } as T;
      }

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
        if (addresses.length === 1) {
          const raw = options.usdcRaw ?? 100_000_000_000n;
          return {
            value: [
              {
                data: {
                  parsed: { info: { mint: "usdc", tokenAmount: { amount: raw.toString() } } },
                },
              },
            ],
          } as T;
        }

        return {
          value: UNIVERSE.map((token) => {
            const raw = options.balances?.[token.symbol];
            if (raw === undefined) return null;
            return {
              data: {
                parsed: {
                  info: {
                    mint: token.mint,
                    state: options.frozen?.includes(token.symbol) ? "frozen" : "initialized",
                    tokenAmount: { amount: raw.toString() },
                  },
                },
              },
            };
          }),
        } as T;
      }

      if (method === "sendTransaction") {
        // Count sends so a test can assert the relay fanned out rather than
        // serialised, and fail the ones the test asked to fail.
        const ordinal = calls.filter((c) => c === "sendTransaction").length - 1;
        if (options.sendFailsAt?.includes(ordinal)) {
          throw new Error("Blockhash not found");
        }
        return `fakeSig${ordinal}` as T;
      }

      if (method === "getSignatureStatuses") {
        const signatures = params[0] as string[];
        return {
          value: signatures.map((signature) => options.statuses?.[signature] ?? null),
        } as T;
      }

      if (method === "getTokenAccountsByOwner") {
        // Every Token-2022 account the owner has, other than the ATAs,
        // which are what getMultipleAccounts above already answers for.
        const value: unknown[] = [];
        let n = 0;
        for (const [symbol, amounts] of Object.entries(options.stray ?? {})) {
          const token = UNIVERSE.find((t) => t.symbol === symbol);
          if (!token) continue;
          const filter = params[1] as { mint?: string } | undefined;
          if (filter?.mint && filter.mint !== token.mint) continue;
          for (const amount of amounts) {
            value.push({
              pubkey: `Stray${symbol}${n++}`.padEnd(44, "1"),
              account: { data: { parsed: { info: { mint: token.mint, tokenAmount: { amount: String(amount) } } } } },
            });
          }
        }
        return { value } as T;
      }

      if (method === "simulateTransaction") {
        const ordinal = calls.filter((c) => c === "simulateTransaction").length - 1;
        if (options.simFailsAt?.includes(ordinal)) {
          return {
            value: {
              err: { InstructionError: [2, { Custom: 6001 }] },
              logs: ["Program log: before", "Program log: slippage", "Program failed"],
              unitsConsumed: 1_234,
            },
          } as T;
        }
        return { value: { err: null, logs: [], unitsConsumed: 50_000 + ordinal } } as T;
      }

      if (method === "getBlockHeight") {
        return (options.blockHeight ?? 426_629_000) as T;
      }

      if (method === "getTransaction") {
        const signature = params[0] as string;
        const asked = (transactionAsks.get(signature) ?? 0) + 1;
        transactionAsks.set(signature, asked);
        if (asked <= (options.lateTransactions?.[signature] ?? 0)) return null as T;
        return (options.transactions?.[signature] ?? null) as T;
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
    /**
     * A quote priced off the same fake prices, with configurable impact so a test
     * can drive a leg into the resize and defer branches.
     */
    quote: async (request: {
      inputMint: string;
      outputMint: string;
      amount: bigint;
      maxAccounts?: number;
    }) => {
      if (options.quoteThrows) throw new Error("jupiter: HTTP 429");

      const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const buying = request.inputMint === usdcMint;
      const token = UNIVERSE.find((t) => t.mint === (buying ? request.outputMint : request.inputMint));
      if (!token) throw new Error("fakeJupiter: unknown mint");

      const usd = options.priceUsd?.[token.symbol] ?? 100;
      const multiplier = MULTIPLIERS[token.symbol] ?? 1;
      const sizeUsd = buying
        ? Number(request.amount) / 1e6
        : (Number(request.amount) / 10 ** token.decimals) * multiplier * usd;
      const perUsd = options.impactPerUsd?.[token.symbol];
      const impact = perUsd !== undefined ? perUsd * sizeUsd : (options.priceImpact?.[token.symbol] ?? 0.001);

      const outAmount = buying
        ? BigInt(
            Math.round(
              ((Number(request.amount) / 1e6 / usd) * (1 - impact) / multiplier) * 10 ** token.decimals,
            ),
          )
        : BigInt(
            Math.round(
              (Number(request.amount) / 10 ** token.decimals) * multiplier * usd * (1 - impact) * 1e6,
            ),
          );

      return {
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        inAmount: String(request.amount),
        outAmount: String(outAmount > 0n ? outAmount : 1n),
        otherAmountThreshold: String(outAmount),
        priceImpactPct: String(impact),
        routePlan: [{ swapInfo: { ammKey: "fakeAmm", label: "Fake" }, percent: 100 }],
        slippageBps: 150,
      };
    },
  };
}

let dbCounter = 0;

export function fakeIssuer(options: FakeOptions = {}) {
  return {
    tokens: async () => [],
    stats: async () => {
      if (options.statsThrow) throw new Error("prestocks: HTTP 429");
      const symbols = UNIVERSE.map((t) => t.symbol);
      const volume = [0, 1, 2, 3].map((day) => ({
        date: `2026-09-1${day}`,
        ...Object.fromEntries(symbols.map((s) => [s, day * 100])),
      }));
      const holders = [0, 1].map((week) => ({
        week: `2026-09-0${week + 1}`,
        ...Object.fromEntries(symbols.map((s) => [s, (week + 1) * 50])),
      }));
      return {
        volume,
        holders,
        launchDates: Object.fromEntries(symbols.map((s) => [s, "2025-08-07T02:00:00Z"])),
        volumeSymbols: symbols,
        holderSymbols: symbols,
      };
    },
  };
}

export function makeServices(options: FakeOptions = {}): Services & { store: Store } {
  PAUSED.clear();
  for (const symbol of options.paused ?? []) PAUSED.add(symbol);

  // A distinct file per call: tests must not share leaderboard state.
  const store = new Store(`/tmp/ps-api-test-${process.pid}-${dbCounter++}.db`);
  return {
    rpc: fakeRpc(options) as unknown as Services["rpc"],
    jupiter: fakeJupiter(options) as unknown as Services["jupiter"],
    issuer: fakeIssuer(options) as unknown as Services["issuer"],
    // No key in tests, so the oracle reports itself unavailable and the
    // routes fall back to the issuer mark.
    pyth: new PythClient(options.pythApiKey),
    store,
    tokenMeta: async () => new Map(),
  };
}

/**
 * A wallet that can actually sign, for exercising the auth path.
 *
 * Tests use real Ed25519 keys rather than disabling signature checks, so the
 * verification code is covered by the same tests that cover the routes.
 */
export class TestWallet {
  readonly #keypair = Keypair.generate();

  get address(): string {
    return this.#keypair.publicKey.toBase58();
  }

  /**
   * Sign the canonical message for an action over a specific body.
   *
   * The body is part of the signature, so a proof cannot be moved onto
   * different content.
   */
  async sign(
    action: string,
    resource: string,
    body: Record<string, unknown> = {},
    issuedAt = Date.now(),
  ): Promise<{ signature: string; issuedAt: number }> {
    const message = new TextEncoder().encode(
      canonicalMessage({
        action,
        resource,
        wallet: this.address,
        issuedAt,
        bodyDigest: await bodyDigest(body),
      }),
    );
    // Ed25519 seeds are the first 32 bytes; wrap in the PKCS8 prefix that
    // WebCrypto expects.
    const seed = this.#keypair.secretKey.slice(0, 32);
    const pkcs8 = new Uint8Array(
      new ArrayBuffer(16 + seed.length),
    );
    pkcs8.set(
      [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20],
      0,
    );
    pkcs8.set(seed, 16);

    const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, message));
    return { signature: btoa(String.fromCharCode(...signature)), issuedAt };
  }
}
