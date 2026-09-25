/**
 * Build, sign, submit, confirm.
 *
 * - A build goes stale: quotes move and the blockhash expires in about a
 *   minute, so a cold build is rebuilt right before signing.
 * - Legs are independent (the build requires USDC for every buy up front),
 *   so they are submitted together rather than in series.
 * - "Not confirmed yet" and "never will be" look the same; only the block
 *   height against the bundle's lastValidBlockHeight tells them apart, so the
 *   confirm poll tracks it.
 */

import { ApiError, api, type BuildResponse, type ConfirmStatus, type Problem, type SubmitResult } from "./api.ts";
import { isUserRejection, type Connection } from "./wallet.ts";

/** Past this age a build is re-run before signing rather than trusted. */
const STALE_MS = 30_000;

/** Give up watching after this; the blockhash cannot outlive it anyway. */
const CONFIRM_TIMEOUT_MS = 120_000;

const POLL_MS = 2_000;

/** How long a settled trade waits for its history to be written. */
const RECORD_WAIT_MS = 3_000;

export type LegState = "pending" | "landed" | "failed" | "expired" | "not-sent";

/** What happened to one transaction, named by the legs it carried. */
export interface TransactionOutcome {
  readonly index: number;
  readonly symbols: readonly string[];
  readonly signature: string | null;
  readonly state: LegState;
  readonly error?: string;
  readonly logs?: readonly string[];
}

export type Phase =
  | "building"
  | "review"
  | "refreshing"
  | "signing"
  | "submitting"
  | "confirming"
  | "settled"
  | "refused"
  | "error";

export interface TradeState {
  readonly phase: Phase;
  readonly build: BuildResponse | null;
  readonly outcomes: readonly TransactionOutcome[];
  readonly error: string | null;
  readonly problems: readonly Problem[];
  /** True once anything has been signed: the flow must not be abandoned. */
  readonly committed: boolean;
}

export const IDLE: TradeState = {
  phase: "building",
  build: null,
  outcomes: [],
  error: null,
  problems: [],
  committed: false,
};

export type BuildRequest =
  | {
      readonly kind: "mirror";
      readonly owner: string;
      readonly indexId?: string;
      readonly strategyId?: string;
      /** Inline allocation. A single company is a one-name basket. */
      readonly weights?: readonly { readonly symbol: string; readonly weight: number }[];
      readonly deployUsd: number;
      readonly slippageBps?: number;
    }
  | { readonly kind: "copy"; readonly leader: string; readonly follower: string; readonly capitalUsd: number; readonly slippageBps?: number }
  | {
      readonly kind: "exit";
      readonly owner: string;
      /** Omitted sells everything the wallet holds. */
      readonly symbols?: readonly string[];
      /** 0 < fraction <= 1. Defaults to selling all of the named positions. */
      readonly fraction?: number;
      readonly slippageBps?: number;
    };

function runBuild(request: BuildRequest, signal?: AbortSignal): Promise<BuildResponse> {
  if (request.kind === "exit") {
    return api.exitBuild(
      {
        owner: request.owner,
        ...(request.symbols === undefined ? {} : { symbols: request.symbols }),
        ...(request.fraction === undefined ? {} : { fraction: request.fraction }),
        ...(request.slippageBps === undefined ? {} : { slippageBps: request.slippageBps }),
      },
      signal,
    );
  }
  if (request.kind === "copy") {
    return api.copyBuild(
      {
        leader: request.leader,
        follower: request.follower,
        capitalUsd: request.capitalUsd,
        ...(request.slippageBps === undefined ? {} : { slippageBps: request.slippageBps }),
      },
      signal,
    );
  }
  return api.mirrorBuild(
    {
      owner: request.owner,
      ...(request.indexId === undefined ? {} : { indexId: request.indexId }),
      ...(request.strategyId === undefined ? {} : { strategyId: request.strategyId }),
      ...(request.weights === undefined ? {} : { weights: request.weights }),
      deployUsd: request.deployUsd,
      ...(request.slippageBps === undefined ? {} : { slippageBps: request.slippageBps }),
    },
    signal,
  );
}

/** Turn any thrown value into the refusal shape the UI renders. */
export function toFailure(error: unknown): Pick<TradeState, "phase" | "error" | "problems"> {
  if (error instanceof ApiError) {
    const problems = Array.isArray(error.body?.["problems"])
      ? (error.body["problems"] as Problem[])
      : [];
    // A 409 is an explainable refusal; anything else is a fault.
    return {
      phase: error.status === 409 || error.status === 400 ? "refused" : "error",
      error: error.message,
      problems,
    };
  }
  return { phase: "error", error: error instanceof Error ? error.message : String(error), problems: [] };
}

export async function buildBundle(
  request: BuildRequest,
  signal?: AbortSignal,
): Promise<BuildResponse> {
  return runBuild(request, signal);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs, submits and follows a bundle to a terminal state. `onState` is
 * called on every transition and never after the returned promise settles.
 */
export async function executeBundle(options: {
  readonly request: BuildRequest;
  readonly build: BuildResponse;
  readonly builtAt: number;
  readonly connection: Connection;
  readonly onState: (patch: Partial<TradeState>) => void;
  readonly signal?: AbortSignal;
}): Promise<TradeState> {
  const { request, connection, onState, signal } = options;
  let build = options.build;

  // ---- 1. refresh a cold build ------------------------------------------
  if (Date.now() - options.builtAt > STALE_MS) {
    onState({ phase: "refreshing" });
    try {
      build = await runBuild(request, signal);
      onState({ build });
    } catch (error) {
      const failure = toFailure(error);
      onState(failure);
      return { ...IDLE, ...failure, build };
    }
  }

  // ---- 2. sign -----------------------------------------------------------
  /*
   * The bundle was built for one address, but the wallet signs with whatever
   * account is active now. If the user switched accounts in between, the fee
   * payer would not match and the relay would refuse with an unhelpful error,
   * so the mismatch is caught here before anything is committed.
   */
  const signer = request.kind === "copy" ? request.follower : request.owner;
  if (connection.address !== signer) {
    const failure = {
      phase: "error" as const,
      error:
        `This was priced for ${signer.slice(0, 4)}…${signer.slice(-4)} but your wallet is now on ` +
        `${connection.address.slice(0, 4)}…${connection.address.slice(-4)}. Nothing was signed. ` +
        `Start again to price it for this account.`,
      problems: [],
    };
    onState(failure);
    return { ...IDLE, ...failure, build };
  }

  onState({ phase: "signing", build });
  let signed: string[];
  try {
    signed = await connection.signAll(build.transactions);
  } catch (error) {
    // Nothing was submitted, so the user can retry. Rejecting in the wallet
    // returns to the review rather than an error screen.
    if (isUserRejection(error)) {
      const back = {
        phase: "review" as const,
        error: "You cancelled in your wallet. Nothing was sent. Approve again when you are ready.",
        problems: [],
      };
      onState(back);
      return { ...IDLE, ...back, build };
    }
    const failure = { phase: "error" as const, error: (error as Error).message, problems: [] };
    onState(failure);
    return { ...IDLE, ...failure, build };
  }

  // ---- 3. submit ---------------------------------------------------------
  // From here funds may be moving. The submit call does not take the abort
  // signal: aborting cannot recall a transaction already on the wire, and it
  // would lose the signatures needed to track it.
  onState({ phase: "submitting", committed: true });
  let results: readonly SubmitResult[];
  try {
    ({ results } = await api.submit({ transactions: signed }));
  } catch (error) {
    // A 4xx is the relay refusing the batch: it verifies every signature
    // before it sends anything, so nothing reached the network and the user
    // can safely start again.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      const refused = {
        phase: "error" as const,
        error: `Nothing was sent. The relay refused it: ${error.message}.`,
        problems: [],
        committed: false,
      };
      onState(refused);
      return { ...IDLE, ...refused, build };
    }
    // Any other failure (timeout, dropped connection, server fault) leaves it
    // unknown whether anything was sent, so the flow must not invite a blind retry.
    const failure = toFailure(error);
    const error_ =
      `${failure.error ?? "The transactions could not be sent."} ` +
      "Some of them may still have gone through: check What I own before trying again.";
    onState({ ...failure, phase: "error", error: error_, committed: true });
    return { ...IDLE, ...failure, phase: "error", error: error_, build, committed: true };
  }

  const outcomesOf = (statuses: readonly ConfirmStatus[], expired: boolean): TransactionOutcome[] =>
    results.map((result) => {
      const symbols = build.legsByTransaction[result.index] ?? [];
      const status = statuses.find((s) => s.signature === result.signature);
      /*
       * A failed send is not proof that nothing was sent: the relay retries on
       * timeout, and a retry of a send that did get through can be refused as
       * "already processed". Until the chain has seen it, the transaction stays
       * pending while its blockhash lives, and becomes "not sent", with the node's
       * reason, once the blockhash has expired. The confirm route answers for every
       * signature, including "unknown".
       */
      const seen = status !== undefined && status.status !== "unknown";
      if (!result.submitted && !seen && expired) {
        // Prefer the node's decoded error over its generic message: the
        // message is "Transaction simulation failed" and the decoded error
        // is "AccountNotFound" or a slippage code.
        const cause = result.err !== undefined ? describeChainError(result.err) : result.error;
        return {
          index: result.index,
          symbols,
          signature: result.signature,
          state: "not-sent" as const,
          ...(cause === undefined ? {} : { error: cause }),
          ...(result.logs?.length ? { logs: result.logs } : {}),
        };
      }
      /*
       * "processed" is not expired: at least one node has seen it in a block, so the
       * blockhash no longer matters. Reporting it as expired would invite a retry
       * and a double purchase. Only a status the cluster has never seen can expire.
       */
      const state: LegState =
        status?.status === "confirmed" || status?.status === "finalized"
          ? "landed"
          : status?.status === "failed"
            ? "failed"
            : status?.status === "processed"
              ? "pending"
              : expired
                ? "expired"
                : "pending";
      return {
        index: result.index,
        symbols,
        signature: result.signature,
        state,
        ...(status?.err ? { error: describeChainError(status.err) } : {}),
      };
    });

  onState({ phase: "confirming", outcomes: outcomesOf([], false) });

  // ---- 4. confirm --------------------------------------------------------
  const signatures = results.map((r) => r.signature);
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let statuses: readonly ConfirmStatus[] = [];
  let expired = false;

  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    try {
      const response = await api.confirm({ signatures });
      statuses = response.statuses;
      // An absent status past the bundle's last valid height is not slow,
      // it is dead: the blockhash can no longer be accepted by any leader.
      expired = response.blockHeight > build.lastValidBlockHeight;
    } catch {
      // A failed poll is not a failed transaction. Keep watching.
    }

    const outcomes = outcomesOf(statuses, expired);
    onState({ outcomes });
    if (outcomes.every((o) => o.state !== "pending")) break;
    if (expired) break;

    await sleep(POLL_MS);
  }

  const outcomes = outcomesOf(statuses, expired);

  // Into the history now rather than at the indexer's next pass, minutes
  // away, so the trade is there when the page refreshes behind this. Waited
  // for only briefly: the trade has happened either way, and the indexer
  // records it later if this does not.
  const landed = outcomes.filter((o) => o.state === "landed" && o.signature).map((o) => o.signature!);
  if (landed.length > 0) {
    // Inside an async function, so even a throw on the way out is caught.
    const recording = (async () => {
      await api.recordTrades({ signatures: landed });
    })().catch(() => undefined);
    await Promise.race([recording, sleep(RECORD_WAIT_MS)]);
  }

  const final: TradeState = {
    phase: "settled",
    build,
    outcomes,
    error: null,
    problems: [],
    committed: true,
  };
  onState(final);
  return final;
}

/**
 * Make a cluster error legible.
 *
 * The raw shape is `{InstructionError:[2,{Custom:6001}]}`. The custom code is
 * the only part that says anything, and 6001 from a Jupiter route is almost
 * always slippage, which is the one cause a user can act on.
 */
export function describeChainError(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") {
    // The handful of cluster errors a user can actually do something about.
    if (err === "AccountNotFound") return "your wallet has no SOL to pay the network fee";
    if (err === "InsufficientFundsForRent") return "your wallet needs a little more SOL for the account deposit";
    if (err === "BlockhashNotFound") return "it took too long to approve, so it expired; try again";
    if (err === "AlreadyProcessed") return "already processed";
    return err;
  }

  const instruction = (err as { InstructionError?: [number, unknown] }).InstructionError;
  if (Array.isArray(instruction)) {
    const [index, detail] = instruction;
    const custom = (detail as { Custom?: number })?.Custom;
    if (custom === 6001) {
      return "the price moved too much before it went through, so it was cancelled; nothing was bought or sold";
    }
    if (custom !== undefined) return `program error ${custom} on instruction ${index}`;
    return `instruction ${index} failed: ${JSON.stringify(detail)}`;
  }
  return JSON.stringify(err);
}

/**
 * A one-line summary; partial fills are expected. Transactions that reached
 * the chain and failed still paid their network fee, so the summary only
 * claims that nothing was bought or sold by them.
 */
export function summarize(outcomes: readonly TransactionOutcome[]): string {
  const landed = outcomes.filter((o) => o.state === "landed").length;
  const pending = outcomes.filter((o) => o.state === "pending").length;
  const total = outcomes.length;
  if (total === 0) return "Nothing was sent.";
  if (landed === total) return total === 1 ? "Done. It went through." : `Done. All ${total} went through.`;
  if (pending > 0) {
    return (
      `${landed} of ${total} went through and ${pending} ${pending === 1 ? "is" : "are"} still waiting. ` +
      "Check What I own in a minute before trying again."
    );
  }
  const none = total === 1 ? "It did not go through." : `None of the ${total} went through.`;
  if (landed === 0) return `${none} Nothing was bought or sold.`;
  return `${landed} of ${total} went through. The others did not, and nothing was bought or sold by them.`;
}
