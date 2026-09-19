/**
 * Build the transactions that move a wallet onto a target allocation.
 *
 * The user never deposits anything and this service never holds a key. It
 * quotes the legs, asks Jupiter for the instructions, packs them into as few
 * versioned transactions as will hold them, and hands back unsigned bytes for
 * the wallet to sign in one prompt.
 *
 * Quotes are taken fresh here rather than reused from planning. A plan may be
 * minutes old by the time someone clicks, and in a market with under $100k in
 * the thinner pools, a stale route is a bad fill.
 */

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
  instructionKey,
  lookupTablesFrom,
  toInstruction,
  type JupiterInstruction,
  type SwapInstructionsResponse,
} from "./instructions.ts";
import { PACKET_DATA_SIZE, compileAndMeasure, packGroups, type InstructionGroup } from "./pack.ts";

/**
 * Successively tighter route constraints.
 *
 * An unconstrained PreStocks route can need 1335 bytes, over the 1232-byte
 * transaction limit, so a leg that does not fit is re-quoted against a
 * narrower search rather than abandoned. Each step trades price improvement
 * for a smaller account set; giving up a few basis points beats not filling.
 */
const ROUTE_LADDER: readonly { readonly maxAccounts: number; readonly onlyDirectRoutes: boolean }[] = [
  { maxAccounts: 40, onlyDirectRoutes: false },
  { maxAccounts: 36, onlyDirectRoutes: false },
  { maxAccounts: 28, onlyDirectRoutes: false },
  { maxAccounts: 24, onlyDirectRoutes: true },
];

/** Headroom over the simulated compute estimate. */
const COMPUTE_MARGIN = 1.25;
/** Per-transaction ceiling the runtime enforces. */
const MAX_COMPUTE_UNITS = 1_400_000;

export interface MirrorLeg {
  readonly symbol: string;
  readonly side: RebalanceOrder["side"];
  /** Notional to trade, in USD. */
  readonly usd: number;
}

export interface MirrorRequest {
  readonly owner: string;
  readonly legs: readonly MirrorLeg[];
  /** Reference price per UI share, used to size sell legs. */
  readonly priceUsdBySymbol: ReadonlyMap<string, number>;
  /** Active scale multiplier per symbol. */
  readonly scaleBySymbol: ReadonlyMap<string, number>;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly slippageBps?: number;
  /**
   * Account cap per route. Lower values keep legs small enough to pack, at the
   * cost of excluding some routes and therefore some price improvement.
   */
  readonly maxAccounts?: number;
}

export interface MirrorBundle {
  /** Unsigned versioned transactions, base64, in signing order. */
  readonly transactions: readonly string[];
  /** Which legs landed in which transaction, by index into `legs`. */
  readonly legsByTransaction: readonly (readonly string[])[];
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  /** Legs that could not be built, with the reason. */
  readonly failed: readonly { readonly symbol: string; readonly reason: string }[];
  readonly byteLengths: readonly number[];
}

/** Quote one leg at the size it will actually trade. */
async function quoteLeg(
  jupiter: JupiterClient,
  leg: MirrorLeg,
  request: MirrorRequest,
  route: { readonly maxAccounts: number; readonly onlyDirectRoutes: boolean },
  excludeDexes: readonly string[],
): Promise<Quote> {
  const token = bySymbol(leg.symbol);
  if (!token) throw new Error(`unknown symbol ${leg.symbol}`);
  const slippageBps = request.slippageBps ?? 100;
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
 * A route that quoted cleanly but failed simulation.
 *
 * Carries the venues it used so the next attempt can exclude them.
 */
class RouteRejected extends Error {
  constructor(message: string, readonly venues: readonly string[]) {
    super(message);
    this.name = "RouteRejected";
  }
}

/** Build the instruction group for one leg at one route setting. */
async function buildGroup(
  jupiter: JupiterClient,
  leg: MirrorLeg,
  request: MirrorRequest,
  route: { readonly maxAccounts: number; readonly onlyDirectRoutes: boolean },
  seenSetup: Set<string>,
  excludeDexes: readonly string[],
): Promise<{
  group: InstructionGroup;
  computeUnits: number;
  budget: readonly JupiterInstruction[];
}> {
  const quote = await quoteLeg(jupiter, leg, request, route, excludeDexes);
  const response = await fetchSwapInstructions<SwapInstructionsResponse>(quote, {
    userPublicKey: request.owner,
  });
  if (response.simulationError) {
    // Carry the venues so the caller can route around whichever one rejected
    // the swap, instead of re-quoting into the same failure.
    throw new RouteRejected(
      `Jupiter simulation failed: ${JSON.stringify(response.simulationError).slice(0, 160)}`,
      venues(quote),
    );
  }

  const instructions: JupiterInstruction[] = [];
  for (const setup of response.setupInstructions) {
    // Setup repeats across legs -- creating the wrapped-SOL account, for one --
    // so it is emitted once per bundle.
    const key = instructionKey(setup);
    if (seenSetup.has(key)) continue;
    seenSetup.add(key);
    instructions.push(setup);
  }
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
  const seenSetup = new Set<string>();
  // Jupiter's own compute-budget instructions are kept only for the priority
  // fee; the unit limit is recomputed per transaction once packing is known.
  let priorityFeeInstructions: readonly JupiterInstruction[] = [];

  const ladder = request.maxAccounts === undefined
    ? ROUTE_LADDER
    : [{ maxAccounts: request.maxAccounts, onlyDirectRoutes: false }, ...ROUTE_LADDER];

  for (const leg of request.legs) {
    let lastError = "no route attempted";
    let placed = false;
    // Venues that already rejected this leg. Excluding them is what turns a
    // failed leg into a filled one, since the fault is usually one pool rather
    // than the trade.
    const excluded = new Set<string>();

    for (const route of ladder) {
      // A setup instruction emitted by a discarded attempt must not be
      // remembered, or the retry will omit an account it still needs.
      const attemptSetup = new Set(seenSetup);
      let built;
      try {
        built = await buildGroup(jupiter, leg, request, route, attemptSetup, [...excluded]);
      } catch (error) {
        lastError = (error as Error).message;
        if (error instanceof RouteRejected) {
          for (const venue of error.venues) excluded.add(venue);
        }
        continue;
      }

      // Reject a route that cannot fit in a transaction by itself before
      // committing to it, so the ladder can try a narrower one.
      const measured = compileAndMeasure({
        payer,
        blockhash: request.blockhash,
        instructions: [...priorityFee(built.budget).map(toInstruction), ...built.group.instructions],
        lookupTables: built.group.lookupTables,
      });
      if (measured === null || measured.bytes > PACKET_DATA_SIZE) {
        lastError = `route needs ${measured?.bytes ?? "too many"} bytes at maxAccounts ${route.maxAccounts}`;
        continue;
      }

      for (const key of attemptSetup) seenSetup.add(key);
      if (built.budget.length > priorityFeeInstructions.length) {
        priorityFeeInstructions = built.budget;
      }
      groups.push(built.group);
      groupSymbols.push(leg.symbol);
      groupComputeUnits.push(built.computeUnits);
      placed = true;
      break;
    }

    if (!placed) failed.push({ symbol: leg.symbol, reason: lastError });
  }

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

  // Pack against a placeholder unit limit. A SetComputeUnitLimit instruction
  // is a fixed five bytes whatever the value, so the real limit can be
  // substituted afterwards without changing how anything fits.
  const placeholder = ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS });
  const preamble = [placeholder, ...priorityFee(priorityFeeInstructions).map(toInstruction)];

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

  // Now that the grouping is known, give each transaction a unit limit that
  // covers every swap in it. Using the largest single leg instead -- which an
  // earlier version did -- exhausts the budget as soon as two swaps share a
  // transaction.
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

    const withBudget = [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...priorityFee(priorityFeeInstructions).map(toInstruction),
      // Drop the placeholder preamble that packing compiled in.
      ...entry.instructions,
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
 * Keep only the priority-fee half of Jupiter's compute budget instructions.
 *
 * The unit limit is ours to set once packing is known; the price per unit is
 * Jupiter's recommendation and worth keeping.
 */
function priorityFee(instructions: readonly JupiterInstruction[]): readonly JupiterInstruction[] {
  // SetComputeUnitLimit is discriminator 0x02; SetComputeUnitPrice is 0x03.
  return instructions.filter((ix) => Buffer.from(ix.data, "base64")[0] === 0x03);
}

function serialize(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString("base64");
}
