import {
  USDC_DECIMALS,
  USDC_MINT,
  bySymbol,
  type RebalanceOrder,
} from "@ps/core";
import { fetchSwapInstructions, venues, type JupiterClient, type Quote } from "@ps/market";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  dedupeWithinTransaction,
  lookupTablesFrom,
  toInstruction,
  type JupiterInstruction,
  type SwapInstructionsResponse,
} from "./instructions.ts";
import { PACKET_DATA_SIZE, compileAndMeasure, packGroups, type InstructionGroup } from "./pack.ts";

/**
 * Successively tighter route constraints for a leg that does not fit in one
 * transaction (an unconstrained route can need 1335 of 1232 bytes). Each step
 * gives up some price improvement for fewer accounts.
 */
const ROUTE_LADDER: readonly { readonly maxAccounts: number; readonly onlyDirectRoutes: boolean }[] = [
  { maxAccounts: 40, onlyDirectRoutes: false },
  { maxAccounts: 36, onlyDirectRoutes: false },
  { maxAccounts: 28, onlyDirectRoutes: false },
  { maxAccounts: 24, onlyDirectRoutes: true },
];

const COMPUTE_MARGIN = 1.25;
const MAX_COMPUTE_UNITS = 1_400_000;
/**
 * Placeholder price for size measurement. SetComputeUnitPrice encodes a
 * fixed-width u64, so the real fee does not change the size.
 */
const MAX_PRIORITY_FEE = 1_000_000;

export interface MirrorLeg {
  readonly symbol: string;
  readonly side: RebalanceOrder["side"];
  readonly usd: number;
  /**
   * Slippage for this leg, overriding the request default. Set from the impact
   * measured in planning, since spreads differ by up to four times across pools.
   */
  readonly slippageBps?: number;
}

export interface MirrorRequest {
  readonly owner: string;
  readonly legs: readonly MirrorLeg[];
  readonly priceUsdBySymbol: ReadonlyMap<string, number>;
  /** Active scale multiplier per symbol. */
  readonly scaleBySymbol: ReadonlyMap<string, number>;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly slippageBps?: number;
  readonly maxAccounts?: number;
}

export interface MirrorBundle {
  readonly transactions: readonly string[];
  readonly legsByTransaction: readonly (readonly string[])[];
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly failed: readonly { readonly symbol: string; readonly reason: string }[];
  readonly byteLengths: readonly number[];
}

async function quoteLeg(
  jupiter: JupiterClient,
  leg: MirrorLeg,
  request: MirrorRequest,
  route: { readonly maxAccounts: number; readonly onlyDirectRoutes: boolean },
  excludeDexes: readonly string[],
): Promise<Quote> {
  const token = bySymbol(leg.symbol);
  if (!token) throw new Error(`unknown symbol ${leg.symbol}`);
  const slippageBps = leg.slippageBps ?? request.slippageBps ?? 150;
  const { maxAccounts, onlyDirectRoutes } = route;

  if (leg.side === "buy") {
    return jupiter.quote(
      {
        inputMint: USDC_MINT,
        outputMint: token.mint,
        amount: BigInt(Math.round(leg.usd * 10 ** USDC_DECIMALS)),
        slippageBps,
        maxAccounts,
        onlyDirectRoutes,
        excludeDexes,
      },
      0, // never serve a cached quote to a transaction builder
    );
  }

  const price = request.priceUsdBySymbol.get(leg.symbol);
  if (price === undefined || price <= 0) throw new Error(`no price for ${leg.symbol}`);
  const multiplier = request.scaleBySymbol.get(leg.symbol);
  if (multiplier === undefined || multiplier <= 0) {
    throw new Error(`no scale multiplier for ${leg.symbol}`);
  }

  // Raw base units are UI shares divided by the multiplier.
  const uiAmount = leg.usd / price;
  const rawAmount = BigInt(Math.round((uiAmount / multiplier) * 10 ** token.decimals));
  if (rawAmount <= 0n) throw new Error(`${leg.symbol} sell size rounds to zero`);

  return jupiter.quote(
    {
      inputMint: token.mint,
      outputMint: USDC_MINT,
      amount: rawAmount,
      slippageBps,
      maxAccounts,
      onlyDirectRoutes,
      excludeDexes,
    },
    0,
  );
}

/**
 * A route that quoted but failed simulation. Carries its venues so the next
 * attempt can exclude them.
 */
class RouteRejected extends Error {
  constructor(message: string, readonly venues: readonly string[]) {
    super(message);
    this.name = "RouteRejected";
  }
}

async function buildGroup(
  jupiter: JupiterClient,
  leg: MirrorLeg,
  request: MirrorRequest,
  route: { readonly maxAccounts: number; readonly onlyDirectRoutes: boolean },
  excludeDexes: readonly string[],
): Promise<{
  group: InstructionGroup;
  computeUnits: number;
  budget: readonly JupiterInstruction[];
}> {
  // Quote immediately before fetching instructions: a reused planner quote is
  // already seconds old and would use up slippage tolerance before signing.
  const quote = await quoteLeg(jupiter, leg, request, route, excludeDexes);
  const response = await fetchSwapInstructions<SwapInstructionsResponse>(quote, {
    userPublicKey: request.owner,
  });
  if (response.simulationError) {
    throw new RouteRejected(
      `Jupiter simulation failed: ${JSON.stringify(response.simulationError).slice(0, 160)}`,
      venues(quote),
    );
  }

  const instructions: JupiterInstruction[] = [...response.setupInstructions];
  instructions.push(response.swapInstruction);
  if (response.cleanupInstruction) instructions.push(response.cleanupInstruction);

  return {
    group: {
      instructions: instructions.map(toInstruction),
      lookupTables: lookupTablesFrom(response),
    },
    computeUnits: response.computeUnitLimit ?? 200_000,
    budget: response.computeBudgetInstructions,
  };
}

export async function buildMirrorBundle(
  jupiter: JupiterClient,
  request: MirrorRequest,
): Promise<MirrorBundle> {
  const payer = new PublicKey(request.owner);
  const failed: { symbol: string; reason: string }[] = [];

  const groups: InstructionGroup[] = [];
  const groupSymbols: string[] = [];
  const groupComputeUnits: number[] = [];
  /**
   * Jupiter's recommended priority fee per leg, in micro-lamports per compute
   * unit. Recommendations can differ by an order of magnitude between legs, so
   * each transaction takes the highest among the legs it carries.
   */
  const groupPriorityFees: number[] = [];

  const ladder = request.maxAccounts === undefined
    ? ROUTE_LADDER
    : [{ maxAccounts: request.maxAccounts, onlyDirectRoutes: false }, ...ROUTE_LADDER];

  // Legs are routed concurrently, since each depends only on its own quotes and
  // excluded venues. Results are placed back in leg order before packing.
  const placeLeg = async (
    leg: MirrorLeg,
  ): Promise<
    | { readonly placed: Awaited<ReturnType<typeof buildGroup>> }
    | { readonly failed: string }
  > => {
    let lastError = "no route attempted";
    const excluded = new Set<string>();

    for (const route of ladder) {
      let built;
      try {
        built = await buildGroup(jupiter, leg, request, route, [...excluded]);
      } catch (error) {
        lastError = (error as Error).message;
        if (error instanceof RouteRejected) {
          for (const venue of error.venues) excluded.add(venue);
        }
        continue;
      }

      // Measure the leg alone with the same budget preamble the packer adds, so
      // a route that cannot fit falls through to a narrower rung here.
      const measured = compileAndMeasure({
        payer,
        blockhash: request.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MAX_PRIORITY_FEE }),
          ...built.group.instructions,
        ],
        lookupTables: built.group.lookupTables,
      });
      if (measured === null || measured.bytes > PACKET_DATA_SIZE) {
        lastError = `route needs ${measured?.bytes ?? "too many"} bytes at maxAccounts ${route.maxAccounts}`;
        continue;
      }

      return { placed: built };
    }

    return { failed: lastError };
  };

  const outcomes = await Promise.all(request.legs.map(placeLeg));
  outcomes.forEach((outcome, i) => {
    const leg = request.legs[i]!;
    if ("failed" in outcome) {
      failed.push({ symbol: leg.symbol, reason: outcome.failed });
      return;
    }
    groups.push(outcome.placed.group);
    groupSymbols.push(leg.symbol);
    groupComputeUnits.push(outcome.placed.computeUnits);
    groupPriorityFees.push(priorityFeeOf(outcome.placed.budget));
  });

  if (groups.length === 0) {
    return {
      transactions: [],
      legsByTransaction: [],
      blockhash: request.blockhash,
      lastValidBlockHeight: request.lastValidBlockHeight,
      failed,
      byteLengths: [],
    };
  }

  const preamble = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MAX_PRIORITY_FEE }),
  ];

  const { packed, oversized } = packGroups({
    payer,
    blockhash: request.blockhash,
    groups,
    preamble,
  });
  for (const entry of oversized) {
    failed.push({
      symbol: groupSymbols[entry.index] ?? "?",
      reason: `route too large to execute: ${entry.reason}`,
    });
  }

  const transactions: string[] = [];
  const byteLengths: number[] = [];
  const legsByTransaction: string[][] = [];

  for (const entry of packed) {
    const units = Math.min(
      MAX_COMPUTE_UNITS,
      Math.ceil(
        entry.groupIndices.reduce((sum, i) => sum + (groupComputeUnits[i] ?? 200_000), 0) *
          COMPUTE_MARGIN,
      ),
    );

    const deduped = dedupeWithinTransaction(entry.instructions);

    // Highest fee among the legs in this transaction, so none is underpriced.
    const microLamports = entry.groupIndices.reduce(
      (highest, i) => Math.max(highest, groupPriorityFees[i] ?? 0),
      0,
    );

    const withBudget = [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...(microLamports > 0
        ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })]
        : []),
      ...deduped,
    ];

    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: request.blockhash,
      instructions: withBudget,
    }).compileToV0Message([...entry.lookupTables]);

    const transaction = new VersionedTransaction(message);
    transactions.push(serialize(transaction));
    byteLengths.push(entry.byteLength);
    legsByTransaction.push(entry.groupIndices.map((i) => groupSymbols[i] ?? "?"));
  }

  return {
    transactions,
    legsByTransaction,
    blockhash: request.blockhash,
    lastValidBlockHeight: request.lastValidBlockHeight,
    failed,
    byteLengths,
  };
}

/**
 * Jupiter's recommended priority fee for a leg, in micro-lamports per compute
 * unit: the little-endian u64 after the SetComputeUnitPrice discriminator (0x03).
 */
function priorityFeeOf(instructions: readonly JupiterInstruction[]): number {
  for (const instruction of instructions) {
    const data = Buffer.from(instruction.data, "base64");
    if (data[0] === 0x03 && data.length >= 9) return Number(data.readBigUInt64LE(1));
  }
  return 0;
}

function serialize(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}
