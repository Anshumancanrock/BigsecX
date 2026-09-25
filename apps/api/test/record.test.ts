import { afterEach, describe, expect, test } from "bun:test";
import { UNIVERSE } from "@ps/core";
import { createApp } from "../src/app.ts";
import { MULTIPLIERS, makeServices, type FakeOptions } from "./fakes.ts";
import type { Store } from "@ps/db";

const open: Store[] = [];
function app(options: FakeOptions = {}) {
  const services = makeServices(options);
  open.push(services.store);
  return createApp(services);
}
afterEach(() => {
  while (open.length) open.pop()?.close();
});

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OPENAI = UNIVERSE.find((t) => t.symbol === "OPENAI")!;
const WALLET = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL";
const SIG = "5".repeat(88);
const LATE = "6".repeat(88);
const AIRDROP = "7".repeat(88);

function buy(owner: string, signer: boolean) {
  return {
    slot: 450_340_000,
    blockTime: 1_790_349_000,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner, uiTokenAmount: { amount: "10000000", decimals: 6 } },
        { accountIndex: 2, mint: OPENAI.mint, owner, uiTokenAmount: { amount: "0", decimals: 9 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner, uiTokenAmount: { amount: "5000000", decimals: 6 } },
        { accountIndex: 2, mint: OPENAI.mint, owner, uiTokenAmount: { amount: "2482598", decimals: 9 } },
      ],
    },
    transaction: {
      signatures: [SIG],
      message: {
        accountKeys: [
          { pubkey: signer ? owner : "Payer1111111111111111111111111111111111111", signer: true },
          { pubkey: "UsdcAccount11111111111111111111111111111111", signer: false },
          { pubkey: "ShareAccount1111111111111111111111111111111", signer: false },
        ],
      },
    },
  };
}

const record = (a: ReturnType<typeof createApp>, signatures: unknown) =>
  a.request("/api/trades/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signatures }),
  });

const historyOf = async (a: ReturnType<typeof createApp>, wallet: string) =>
  ((await (await a.request(`/api/traders/${wallet}/trades`)).json()) as {
    trades: { signature: string; symbol: string; side: string; uiAmount: number; valueUsd: number | null }[];
  }).trades;

describe("recording a trade the moment it lands", () => {
  test("writes what the chain says the trade was", async () => {
    const a = app({ transactions: { [SIG]: buy(WALLET, true) } });
    const res = await record(a, [SIG]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 1, trades: 1, notFound: 0 });

    const [trade] = await historyOf(a, WALLET);
    expect(trade).toMatchObject({ signature: SIG, symbol: "OPENAI", side: "buy", valueUsd: 5 });
    // Raw shares through the mint's multiplier, as a holder sees them.
    expect(trade!.uiAmount).toBeCloseTo((2_482_598 / 1e9) * MULTIPLIERS["OPENAI"]!, 9);
  });

  test("writes a trade once, however often it is reported", async () => {
    const a = app({ transactions: { [SIG]: buy(WALLET, true) } });
    await record(a, [SIG]);
    const again = (await (await record(a, [SIG, SIG])).json()) as { recorded: number };
    expect(again.recorded).toBe(0);
    expect(await historyOf(a, WALLET)).toHaveLength(1);
  });

  test("looks again for a transaction the node has not seen yet", async () => {
    const a = app({ transactions: { [LATE]: buy(WALLET, true) }, lateTransactions: { [LATE]: 1 } });
    const res = (await (await record(a, [LATE])).json()) as { recorded: number; notFound: number };
    expect(res).toMatchObject({ recorded: 1, notFound: 0 });
  });

  test("says so when the chain has no such transaction, and writes nothing", async () => {
    const a = app();
    const res = (await (await record(a, [SIG])).json()) as { recorded: number; notFound: number };
    expect(res).toMatchObject({ recorded: 0, notFound: 1 });
  });

  test("does not credit a wallet that did not sign", async () => {
    // Shares arriving in a wallet that never signed are a transfer to it,
    // not a trade it made.
    const a = app({ transactions: { [AIRDROP]: buy(WALLET, false) } });
    const res = (await (await record(a, [AIRDROP])).json()) as { recorded: number };
    expect(res.recorded).toBe(0);
    expect(await historyOf(a, WALLET)).toHaveLength(0);
  });

  test("takes only a short list of real signatures", async () => {
    const a = app();
    for (const bad of [[], "5".repeat(88), ["not-a-signature"], [42], Array.from({ length: 21 }, () => SIG)]) {
      expect((await record(a, bad)).status).toBe(400);
    }
  });
});
