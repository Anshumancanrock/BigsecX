/**
 * Review and sign. Nothing is signed before it is shown priced, including
 * refused legs and the total cost; lib/trade.ts rebuilds a stale bundle
 * before signing. Once anything is signed the sheet cannot be dismissed:
 * legs settle independently and this is the only record of which landed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet } from "../../components/Sheet.tsx";
import { useWallet } from "../wallet/WalletContext.tsx";
import { useCompanyName } from "../../lib/market.ts";
import { FundingHelp } from "../wallet/FundingHelp.tsx";
import { SuccessMark } from "../../components/SuccessMark.tsx";
import {
  IDLE,
  buildBundle,
  describeChainError,
  executeBundle,
  summarize,
  toFailure,
  type BuildRequest,
  type TradeState,
} from "../../lib/trade.ts";
import { api, type Problem, type SimulationResponse } from "../../lib/api.ts";
import { list, percent, shares, shortAddress, usd } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";

const PHASES = [
  { key: "signing", label: "Approve in your wallet" },
  { key: "submitting", label: "Sending it to the network" },
  { key: "confirming", label: "Waiting for it to go through" },
] as const;

const ORDER: Record<string, number> = {
  building: 0,
  review: 0,
  refreshing: 1,
  signing: 1,
  submitting: 2,
  confirming: 3,
  settled: 4,
};

export function TradeDialog({
  request,
  title,
  onClose,
  onSettled,
}: {
  request: BuildRequest;
  title: string;
  onClose: () => void;
  onSettled?: () => void;
}) {
  const wallet = useWallet();
  const [state, setState] = useState<TradeState>(IDLE);
  const builtAt = useRef(0);
  // Bumped by "Try again", which re-runs the build below from scratch.
  const [attempt, setAttempt] = useState(0);

  const patch = useCallback((next: Partial<TradeState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  // ---- build on open ------------------------------------------------------
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setState(IDLE);

    buildBundle(request, controller.signal)
      .then((build) => {
        if (!live) return;
        builtAt.current = Date.now();
        setSim(null);
        setState({ ...IDLE, phase: "review", build });
      })
      .catch((error: unknown) => {
        if (!live || controller.signal.aborted) return;
        setState({ ...IDLE, ...toFailure(error) });
      });

    return () => {
      live = false;
      controller.abort();
    };
    // The request object is rebuilt by the parent on every render, so it is
    // compared by value rather than identity.
  }, [JSON.stringify(request), attempt]);

  /**
   * Re-entrancy guard. The button disappears after the first click, but only
   * after a re-render; a double fire would build, sign and submit twice.
   */
  const running = useRef(false);

  /*
   * Test run. The mints exist only on mainnet, so the bundle is simulated
   * against mainnet state and discarded. Nothing is signed; it catches routes
   * that no longer fill and blockhashes that have gone stale.
   */
  const [sim, setSim] = useState<SimulationResponse | null>(null);
  const [simulating, setSimulating] = useState(false);

  const dryRun = useCallback(async () => {
    if (!state.build || simulating) return;
    setSimulating(true);
    setSim(null);
    try {
      setSim(await api.simulate({ transactions: state.build.transactions }));
    } catch (error) {
      setSim({
        results: [],
        wouldLand: false,
        ok: 0,
        failed: 0,
        note: (error as Error).message,
      });
    } finally {
      setSimulating(false);
    }
  }, [state.build, simulating]);

  const run = useCallback(async () => {
    if (!wallet.connection || !state.build) return;
    if (running.current) return;
    running.current = true;
    patch({ error: null });

    // executeBundle never throws; it returns the terminal state.
    const settled = await executeBundle({
      request,
      build: state.build,
      builtAt: builtAt.current,
      connection: wallet.connection,
      onState: patch,
    });

    // Released only when nothing was sent (a cancelled signature or a refusal
    // during the re-quote). Once `committed` is set the bundle must never be sent again.
    if (!settled.committed) running.current = false;
    // A cancel returns to the review; only a real outcome counts as settled.
    if (settled.phase !== "review") onSettled?.();
  }, [wallet.connection, state.build, request, patch, onSettled]);

  const busy = ["refreshing", "signing", "submitting", "confirming"].includes(state.phase);
  const dismissible = !busy;
  const selling = request.kind === "exit";

  return (
    <Sheet
      title={title}
      onClose={onClose}
      dismissible={dismissible}
      footer={
        state.phase === "review" ? (
          <>
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-ghost"
              onClick={() => void dryRun()}
              disabled={simulating}
              title="Runs it against the live market without signing or spending anything"
            >
              {simulating ? "Testing…" : "Test run (free)"}
            </button>
            <button className="btn-mint" onClick={() => void run()} disabled={!wallet.address}>
              {wallet.address ? "Approve in wallet" : "Connect a wallet first"}
            </button>
          </>
        ) : state.phase === "settled" ? (
          /* After a fill, offer a way to the positions it created. */
          state.outcomes.some((o) => o.state === "landed") ? (
            <>
              <button className="btn-ghost" onClick={onClose}>
                Close
              </button>
              <button
                className="btn-mint"
                onClick={() => {
                  onClose();
                  navigate("/portfolio");
                }}
              >
                See what I own
              </button>
            </>
          ) : (
            <button className="btn-mint" onClick={onClose}>
              Close
            </button>
          )
        ) : state.phase === "refused" || state.phase === "error" ? (
          <>
            <button className="btn-ghost" onClick={onClose}>
              Close
            </button>
            {/* Retry only while nothing has been sent; after a submit, point to the wallet instead. */}
            {state.committed ? (
              <button
                className="btn-mint"
                onClick={() => {
                  onClose();
                  navigate("/portfolio");
                }}
              >
                Check what I own
              </button>
            ) : (
              <button
                className="btn-mint"
                onClick={() => {
                  running.current = false;
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            )}
          </>
        ) : null
      }
    >
      {state.phase === "building" ? (
        <p className="note" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="spin" /> Getting live prices…
        </p>
      ) : null}

      {state.phase === "refused" ? <Refusal state={state} selling={selling} owner={wallet.address} /> : null}

      {state.phase === "error" ? (
        <div className="banner bad">
          <span>{state.error}</span>
        </div>
      ) : null}

      {state.phase === "review" && state.build ? (
        <>
          {state.error ? (
            <div className="banner" style={{ marginBottom: 14 }}>
              <span>{state.error}</span>
            </div>
          ) : null}
          <Review
            state={state}
            selling={selling}
            askedUsd={request.kind === "copy" ? request.capitalUsd : request.kind === "mirror" ? request.deployUsd : undefined}
          />
          {sim ? <DryRun sim={sim} /> : null}
        </>
      ) : null}

      {state.phase === "settled" && state.outcomes.some((o) => o.state === "landed") ? (
        <Landed outcomes={state.outcomes} selling={selling} />
      ) : null}
      {busy || state.phase === "settled" ? <Progress state={state} /> : null}
    </Sheet>
  );
}

/**
 * The moment a trade has landed, said plainly: what arrived, and whether
 * anything did not. The per-transaction detail stays below it.
 */
function Landed({ outcomes, selling }: { outcomes: TradeState["outcomes"]; selling: boolean }) {
  const nameOf = useCompanyName();
  const landed = outcomes.filter((o) => o.state === "landed").flatMap((o) => o.symbols.map(nameOf));
  const everything = outcomes.every((o) => o.state === "landed");
  const names =
    landed.length <= 1 ? (landed[0] ?? "Your order") : `${landed.slice(0, -1).join(", ")} and ${landed[landed.length - 1]}`;
  const detail = selling
    ? `${names} sold. The USDC is in your wallet.`
    : `${names} ${landed.length === 1 ? "is" : "are"} now in your own wallet.`;
  return (
    <SuccessMark
      title={selling ? "Sold" : "You own it"}
      detail={everything ? detail : `${detail} Some did not go through; the details are below.`}
    />
  );
}

function DryRun({ sim }: { sim: SimulationResponse }) {
  const total = sim.ok + sim.failed;
  return (
    <div style={{ marginTop: 16 }}>
      <div className={`banner ${sim.wouldLand ? "" : "bad"}`}>
        <span>
          {sim.wouldLand
            ? "Test passed: this would go through right now. Nothing was signed or spent."
            : total > 0
              ? `Test failed: ${sim.failed} of ${total} would not go through right now. Nothing was signed or spent.`
              : `The test could not run: ${sim.note}`}
        </span>
      </div>
      {sim.results
        .filter((r) => !r.ok)
        .map((r) => (
          <p className="note" key={r.index}>
            · step {r.index + 1}: {describeChainError(r.err) || r.error}
          </p>
        ))}
      {sim.wouldLand ? (
        <p className="note" style={{ marginTop: 8, color: "hsl(var(--fg-faint))" }}>
          A test cannot promise the price will not move between now and when you approve.
        </p>
      ) : null}
    </div>
  );
}

/** A refusal reason, in the words of the person it happened to. */
function describeProblem(problem: Problem, selling: boolean): { title: string; body: string } {
  switch (problem.kind) {
    case "insufficient-usdc":
      return {
        title: "Not enough USDC",
        body:
          problem.requiredUsd !== undefined && problem.availableUsd !== undefined
            ? `This needs ${usd(problem.requiredUsd)} of USDC. Your wallet has ${usd(problem.availableUsd)}.`
            : problem.message,
      };
    case "insufficient-sol": {
      const need = problem.requiredLamports ?? 3_000_000;
      const have = problem.lamports ?? 0;
      return {
        title: "Not enough SOL for fees",
        body:
          `This needs about ${(need / 1e9).toFixed(4)} SOL. Your wallet has ${(have / 1e9).toFixed(4)}.` +
          (problem.newAccounts
            ? ` That covers the network fee and a refundable deposit for each of the ${problem.newAccounts} companies you do not hold yet.`
            : ""),
      };
    }
    case "paused":
      return {
        title: "Trading is paused",
        body: `The issuer has paused ${list(problem.symbols).join(", ") || "this token"}. Nobody can trade it until they resume.`,
      };
    case "no-executable-legs": {
      // "Try a smaller amount" is wrong advice for an order already at the
      // smallest size there is; say what can actually help.
      const smallest = list(problem.deferred).length > 0 && list(problem.deferred).every((d) => d.usd <= 5.01);
      return {
        title: "The market is too thin right now",
        body: smallest
          ? "Even the smallest amount would move the price too far right now. Try again in a little while, or pick another company."
          : "There are not enough buyers and sellers to fill this without moving the price too far. Try a smaller amount, or try again later.",
      };
    }
    case "insufficient-balance":
      return {
        title: selling ? "Not enough to sell" : "Not enough to sell first",
        body: "The wallet does not hold as much as this would sell. If the tokens are frozen by the issuer they cannot be moved.",
      };
    case "not-atomic":
      return {
        title: "Would need to sell first",
        body: "This would sell some of what you hold to pay for the rest, which cannot be done safely in one go. Sell first, then buy.",
      };
    case "unpriced-holding":
      return {
        title: "A price is missing",
        body: `We could not get a price for ${list(problem.symbols).join(", ")} just now. Try again in a minute.`,
      };
    default:
      return { title: problem.kind.replace(/-/g, " "), body: problem.message };
  }
}

function Refusal({ state, selling, owner }: { state: TradeState; selling: boolean; owner: string | null }) {
  // The server's top-line error is just the first problem's message, so
  // showing both repeats one line verbatim. The summary states what
  // happened; the list states why, once each.
  const problems = state.problems;
  const needUsdc = problems.some((p) => p.kind === "insufficient-usdc");
  const needSol = problems.some((p) => p.kind === "insufficient-sol");
  const sol = problems.find((p) => p.kind === "insufficient-sol");

  return (
    <>
      <div className="banner bad">
        <span>
          {problems.length === 0
            ? state.error
            : needUsdc || needSol
              ? "Add money to your wallet first. Nothing was signed."
              : "This cannot go through right now. Nothing was signed."}
        </span>
      </div>

      {problems.map((problem) => {
        const words = describeProblem(problem, selling);
        return (
          <div className="problem" key={problem.kind}>
            <b>{words.title}</b>
            <span>{words.body}</span>
          </div>
        );
      })}

      {/*
 * A shortfall refusal links to funding help: the address to send to and the
 * network to use, so the user has a next step.
 */}
      {(needUsdc || needSol) && owner ? (
        <FundingHelp
          address={owner}
          needUsdc={needUsdc}
          needSol={needSol}
          {...(sol?.requiredLamports ? { solAmount: `about ${(Math.max(sol.requiredLamports / 1e9, 0.01) * 1.5).toFixed(2)} SOL` } : {})}
        />
      ) : null}
    </>
  );
}

function Review({
  state,
  selling,
  askedUsd,
}: {
  state: TradeState;
  selling: boolean;
  askedUsd?: number | undefined;
}) {
  const build = state.build!;
  const nameOf = useCompanyName();
  const legs = list(build.legs);
  // Only meaningful for a pure purchase: with sells in the bundle the legs'
  // total is turnover, not new money. Shown so a $50 request that can only
  // place $34 does not look like $16 went missing.
  const allBuys = legs.every((l) => l.side === "buy");
  const unspentUsd = allBuys && askedUsd !== undefined ? askedUsd - build.totalUsd : 0;
  const costHigh = build.costFraction > 0.03;
  const steps = list(build.transactions).length;

  // The endpoints name their subject differently: a mirror names a target,
  // a copy names a leader, a sale names nothing. Reconciled here rather than
  // on the server, so no response has to pretend to be another.
  const subject = build.leader ? `${shortAddress(build.leader, 4, 4)}'s mix` : build.target;
  const costUsd = build.totalCostUsd ?? build.totalUsd * build.costFraction;
  const proceeds = legs.reduce((sum, l) => sum + (l.expectedUsd ?? 0), 0);

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        {subject && !selling ? (
          <div className="kv">
            <span>{build.leader ? "Copying" : "Buying"}</span>
            <span>{subject}</span>
          </div>
        ) : null}
        <div className="kv">
          <span>{selling ? "You are selling" : "You pay"}</span>
          <span className="num">{usd(build.totalUsd)}</span>
        </div>
        {selling && proceeds > 0 ? (
          <div className="kv">
            <span>You get back about</span>
            <span className="num">{usd(proceeds)} USDC</span>
          </div>
        ) : null}
        {unspentUsd >= 1 ? (
          <div className="kv">
            <span>Stays in your wallet</span>
            <span className="num">{usd(unspentUsd)} USDC</span>
          </div>
        ) : null}
        <div className="kv">
          <span>Fees and price gap</span>
          {/* A negative cost means the price is in the user's favour; it is not shown as a refund. */}
          <span className={`num ${costHigh ? "down" : ""}`}>
            {costUsd > 0.005 ? `${usd(costUsd)} · ${percent(build.costFraction)}` : "None, the price is in your favour"}
          </span>
        </div>
      </div>

      {costHigh ? (
        <div className="banner bad">
          <span>
            Fees and the price gap come to {percent(build.costFraction)} of this. That is what trading a small market
            costs, and a similar gap applies again when you sell.
          </span>
        </div>
      ) : null}

      {build.scope ? (
        <div className="banner">
          <span>{build.scope}</span>
        </div>
      ) : null}

      <div style={{ margin: "6px 0 2px" }}>
        {legs.map((leg) => (
          <div className="leg" key={`${leg.side}-${leg.symbol}`}>
            <span className={`side ${leg.side}`}>{leg.side}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              {nameOf(leg.symbol)}
              <small className="leg-sub">
                {leg.side === "buy" && leg.expectedShares
                  ? `You get about ${shares(leg.expectedShares)} tokens`
                  : leg.side === "sell" && leg.expectedUsd
                    ? `About ${usd(leg.expectedUsd)} back`
                    : ""}
                {/* The tolerance also covers the transfer fee; the price
                    itself may move only by what is left over. */}
                {leg.slippageBps !== undefined
                  ? `${(leg.side === "buy" && leg.expectedShares) || (leg.side === "sell" && leg.expectedUsd) ? " · " : ""}cancelled if the price moves over ${((leg.slippageBps - (leg.feeAllowanceBps ?? 0)) / 100).toFixed(1)}%`
                  : ""}
              </small>
            </span>
            <span className="num" style={{ minWidth: 78, textAlign: "right" }}>
              {usd(leg.usd)}
            </span>
          </div>
        ))}
      </div>

      {list(build.failed).length > 0 || (build.deferred?.length ?? 0) > 0 ? (
        <div style={{ marginTop: 14 }}>
          <p className="note" style={{ color: "hsl(var(--fg-faint))", marginBottom: 4 }}>
            Left out
          </p>
          {list(build.failed).map((f) => (
            <p className="note" key={f.symbol}>
              · {nameOf(f.symbol)}: {f.reason}
            </p>
          ))}
          {list(build.deferred).map((d) => (
            <p className="note" key={d.symbol}>
              · {nameOf(d.symbol)}: {d.reason}
            </p>
          ))}
        </div>
      ) : null}

      {/* Said once, plainly, because it is the one thing about these
          transactions a person would not guess. */}
      {steps > 1 ? (
        <p className="note" style={{ marginTop: 14 }}>
          Your wallet will ask you to approve {steps} transactions at once. Each one goes through on its own, so
          occasionally some go through and others do not. You will see exactly which.
        </p>
      ) : null}
    </>
  );
}

function Progress({ state }: { state: TradeState }) {
  const position = ORDER[state.phase] ?? 0;
  const nameOf = useCompanyName();

  return (
    <>
      {state.phase === "refreshing" ? (
        <p className="note" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span className="spin" /> Prices moved while this was open. Getting fresh ones before you approve.
        </p>
      ) : null}

      <div className="steps">
        {PHASES.map((phase, i) => {
          const step = i + 1;
          const status = position > step ? "done" : position === step ? "active" : "";
          return (
            <div className={`step ${status}`} key={phase.key}>
              <span className="step-dot" />
              {phase.label}
            </div>
          );
        })}
      </div>

      {state.outcomes.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          {state.outcomes.map((outcome) => (
            <div className="leg" key={outcome.index}>
              <StateBadge state={outcome.state} />
              <span style={{ flex: 1 }}>
                {outcome.symbols.map(nameOf).join(", ") || `transaction ${outcome.index + 1}`}
              </span>
              {outcome.signature && outcome.state !== "not-sent" ? (
                <a
                  className="mono-link"
                  href={`https://solscan.io/tx/${outcome.signature}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  title="See it on Solscan, a public record of every Solana transaction"
                >
                  Receipt ↗
                </a>
              ) : null}
            </div>
          ))}
          {state.outcomes.some((o) => o.error) ? (
            <div style={{ marginTop: 10 }}>
              {state.outcomes
                .filter((o) => o.error)
                .map((o) => (
                  <div key={o.index}>
                    <p className="note">
                      · {o.symbols.map(nameOf).join(", ") || `transaction ${o.index + 1}`}: {o.error}
                    </p>
                    {o.logs?.length ? (
                      <details style={{ margin: "6px 0 0 12px" }}>
                        <summary className="note" style={{ cursor: "pointer" }}>
                          Technical details
                        </summary>
                        <pre
                          className="num"
                          style={{
                            marginTop: 6,
                            padding: 10,
                            borderRadius: "var(--r-sm)",
                            background: "hsl(var(--card))",
                            fontSize: 10.5,
                            lineHeight: 1.5,
                            color: "hsl(var(--fg-muted))",
                            overflowX: "auto",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {o.logs.join("\n")}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {state.phase === "settled" ? (
        <div className="banner" style={{ marginTop: 16 }}>
          <span>{summarize(state.outcomes)}</span>
        </div>
      ) : null}
    </>
  );
}

function StateBadge({ state }: { state: string }) {
  const label: Record<string, string> = {
    landed: "done",
    failed: "failed",
    expired: "timed out",
    pending: "waiting",
    "not-sent": "not sent",
  };
  const tone = state === "landed" ? "good" : state === "pending" ? "" : "warn";
  return <span className={`pill ${tone}`} style={{ minWidth: 62, textAlign: "center" }}>{label[state] ?? state}</span>;
}
