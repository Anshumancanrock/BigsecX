import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BuildResponse, ConfirmResponse, SubmitResponse } from "../src/lib/api.ts";
import type { Connection } from "../src/lib/wallet.ts";

/* ------------------------------------------------------------- test doubles */

interface Script {
  /** How many transactions the default submit/confirm doubles answer for. */
  txCount: number;
  build: () => Promise<BuildResponse>;
  submit: () => Promise<SubmitResponse>;
  confirm: () => Promise<ConfirmResponse>;
  builds: number;
  submits: number;
  confirms: number;
  /** The signatures each record call was given. */
  recorded: string[][];
  record: () => Promise<unknown>;
}

let script: Script;

class FakeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

mock.module("../src/lib/api.ts", () => ({
  ApiError: FakeApiError,
  api: {
    mirrorBuild: () => {
      script.builds++;
      return script.build();
    },
    copyBuild: () => {
      script.builds++;
      return script.build();
    },
    submit: () => {
      script.submits++;
      return script.submit();
    },
    confirm: () => {
      script.confirms++;
      return script.confirm();
    },
    recordTrades: (body: { signatures: readonly string[] }) => {
      script.recorded.push([...body.signatures]);
      return script.record();
    },
  },
}));

const {
  buildBundle,
  describeChainError,
  executeBundle,
  summarize,
  toFailure,
} = await import("../src/lib/trade.ts");

const LAST_VALID = 1_000;

function bundle(transactions = 2): BuildResponse {
  return {
    target: "Prediction Markets",
    targetSource: "index",
    transactions: Array.from({ length: transactions }, (_, i) => `tx${i}`),
    legsByTransaction: Array.from({ length: transactions }, (_, i) => [`SYM${i}`]),
    blockhash: "hash",
    lastValidBlockHeight: LAST_VALID,
    failed: [],
    byteLengths: Array.from({ length: transactions }, () => 900),
    legs: Array.from({ length: transactions }, (_, i) => ({
      symbol: `SYM${i}`,
      side: "buy" as const,
      usd: 100,
      fromWeight: 0,
      toWeight: 0.5,
    })),
    totalUsd: 200,
    totalCostUsd: 3,
    costFraction: 0.015,
    atomic: false,
    note: "",
  };
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    walletName: "Fake",
    address: "Wa11et",
    signAll: async (txs) => txs.map((t) => `signed:${t}`),
    signMessage: async () => new Uint8Array(64),
    disconnect: async () => {},
    onChange: () => () => {},
    ...overrides,
  };
}

const request = { kind: "mirror" as const, owner: "Wa11et", indexId: "prediction", deployUsd: 200 };

const submitted = (n: number): SubmitResponse => ({
  results: Array.from({ length: n }, (_, i) => ({
    index: i,
    signature: `sig${i}`,
    submitted: true,
  })),
  submitted: n,
  failed: 0,
});

const confirmed = (n: number, blockHeight = 900): ConfirmResponse => ({
  blockHeight,
  statuses: Array.from({ length: n }, (_, i) => ({
    signature: `sig${i}`,
    status: "confirmed" as const,
    slot: 1,
    err: null,
  })),
});

beforeEach(() => {
  script = {
    txCount: 2,
    // Derived from txCount rather than hard-coded, so a test that builds a
    // different number of transactions does not silently get a short
    // response and a pending poll loop.
    build: async () => bundle(script.txCount),
    submit: async () => submitted(script.txCount),
    confirm: async () => confirmed(script.txCount),
    builds: 0,
    submits: 0,
    confirms: 0,
    recorded: [],
    record: async () => ({ recorded: 0, trades: 0, notFound: 0 }),
  };
});

afterEach(() => {
  mock.restore();
});

/* ------------------------------------------------------------------- tests */

describe("failure mapping", () => {
  test("a 409 is a refusal we can explain, and keeps every problem", () => {
    const problems = [
      { kind: "insufficient-usdc", message: "not enough USDC", requiredUsd: 500, availableUsd: 12 },
      { kind: "insufficient-sol", message: "not enough SOL", lamports: 1_000 },
    ];
    const failure = toFailure(new FakeApiError(409, "not enough USDC", { problems }));
    expect(failure.phase).toBe("refused");
    // Both, not just the first: the user needs to fix both before retrying.
    expect(failure.problems).toHaveLength(2);
  });

  test("a 500 is a fault, not a refusal", () => {
    expect(toFailure(new FakeApiError(500, "internal error")).phase).toBe("error");
  });

  test("a thrown non-Error still produces a message", () => {
    expect(toFailure("boom").error).toBe("boom");
  });
});

describe("chain error decoding", () => {
  test("6001 is named, because slippage is the one cause a user can act on", () => {
    expect(describeChainError({ InstructionError: [2, { Custom: 6001 }] })).toContain("price moved");
  });

  test("other custom codes keep their number and position", () => {
    expect(describeChainError({ InstructionError: [1, { Custom: 6023 }] })).toBe(
      "program error 6023 on instruction 1",
    );
  });

  test("an unrecognised shape is shown rather than swallowed", () => {
    expect(describeChainError({ AccountInUse: true })).toBe('{"AccountInUse":true}');
    expect(describeChainError(null)).toBe("");
  });
});

describe("summaries are honest about partial fills", () => {
  const outcome = (state: string) => ({ index: 0, symbols: [], signature: "s", state }) as never;
  test("all, none and some read differently", () => {
    expect(summarize([outcome("landed"), outcome("landed")])).toContain("All 2");
    expect(summarize([outcome("expired"), outcome("failed")])).toContain("None of the 2");
    expect(summarize([outcome("landed"), outcome("expired")])).toContain("1 of 2");
    expect(summarize([])).toContain("Nothing was sent");
  });
});

describe("executeBundle", () => {
  test("a fresh build is signed as-is, without re-quoting", async () => {
    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection(),
      onState: () => {},
    });
    expect(script.builds).toBe(0);
    expect(state.phase).toBe("settled");
    expect(state.outcomes.every((o) => o.state === "landed")).toBe(true);
  });

  test("a stale build is re-quoted before signing", async () => {
    // The whole reason this exists: a build left on screen for two minutes
    // carries prices that have moved and a blockhash that is nearly dead.
    const phases: string[] = [];
    await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now() - 60_000,
      connection: connection(),
      onState: (patch) => {
        if (patch.phase) phases.push(patch.phase);
      },
    });
    expect(script.builds).toBe(1);
    expect(phases[0]).toBe("refreshing");
  });

  test("a refusal during the refresh stops before anything is signed", async () => {
    let signed = false;
    script.build = async () => {
      throw new FakeApiError(409, "price moved", { problems: [] });
    };
    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now() - 60_000,
      connection: connection({
        signAll: async () => {
          signed = true;
          return [];
        },
      }),
      onState: () => {},
    });
    expect(signed).toBe(false);
    expect(state.phase).toBe("refused");
    expect(state.committed).toBe(false);
  });

  test("a cancelled signature leaves nothing committed and nothing submitted", async () => {
    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection({
        signAll: async () => {
          throw new Error("Signing cancelled");
        },
      }),
      onState: () => {},
    });
    // Back to the review, with the build intact, so the user can approve
    // again without starting over.
    expect(state.phase).toBe("review");
    expect(state.build).not.toBeNull();
    expect(state.error).toContain("cancelled");
    expect(state.committed).toBe(false);
    expect(script.submits).toBe(0);
  });

  test("a wallet that fails to sign is an error, not a cancel", async () => {
    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection({
        signAll: async () => {
          throw new Error("Phantom could not sign: device locked");
        },
      }),
      onState: () => {},
    });
    expect(state.phase).toBe("error");
    expect(state.committed).toBe(false);
  });

  test("a transaction the relay could not send is 'not sent', not 'failed'", async () => {
    // A "not-sent" transaction cost nothing, so the label waits until the
    // blockhash has expired: until then, a send that errored may still have
    // reached the cluster on an earlier attempt.
    script.submit = async () => ({
      results: [
        { index: 0, signature: "sig0", submitted: true },
        { index: 1, signature: "sig1", submitted: false, error: "Blockhash not found" },
      ],
      submitted: 1,
      failed: 1,
    });
    script.confirm = async () => ({
      blockHeight: script.confirms === 1 ? 900 : LAST_VALID + 1,
      statuses: [
        { signature: "sig0", status: "confirmed", slot: 1, err: null },
        { signature: "sig1", status: "unknown", slot: null, err: null },
      ],
    });

    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection(),
      onState: () => {},
    });
    expect(state.outcomes[0]!.state).toBe("landed");
    expect(state.outcomes[1]!.state).toBe("not-sent");
    expect(state.outcomes[1]!.error).toContain("Blockhash");
    expect(summarize(state.outcomes)).toContain("1 of 2");
  });

  test("a failed send is still waited on while its blockhash lives", async () => {
    // The first poll answers "unknown" for the failed one, as the confirm
    // route does for any signature it has not seen. That is not "not sent".
    script.submit = async () => ({
      results: [
        { index: 0, signature: "sig0", submitted: true },
        { index: 1, signature: "sig1", submitted: false, error: "sendTransaction failed after retries: timeout" },
      ],
      submitted: 1,
      failed: 1,
    });
    script.confirm = async () => ({
      blockHeight: script.confirms < 2 ? 900 : LAST_VALID + 1,
      statuses: [
        { signature: "sig0", status: "confirmed", slot: 1, err: null },
        { signature: "sig1", status: "unknown", slot: null, err: null },
      ],
    });
    const seen: string[] = [];
    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection(),
      onState: (patch) => {
        const leg = patch.outcomes?.[1];
        if (leg) seen.push(leg.state);
      },
    });
    // Waiting first, and "not sent" only once nothing could land it.
    expect(seen[0]).toBe("pending");
    expect(seen).not.toContain("expired");
    expect(state.outcomes[1]!.state).toBe("not-sent");
    expect(state.outcomes[1]!.error).toContain("timeout");
  });

  test("a send that errored but reached the cluster on an earlier try is shown as landed", async () => {
    // The relay retries a send that times out; the retry of one that did get
    // through is refused as already processed. Calling that "not sent" is
    // what would make someone buy it again.
    script.submit = async () => ({
      results: [
        { index: 0, signature: "sig0", submitted: true },
        { index: 1, signature: "sig1", submitted: false, error: "already processed", err: "AlreadyProcessed" },
      ],
      submitted: 1,
      failed: 1,
    });
    script.confirm = async () => ({
      blockHeight: 900,
      statuses: [
        { signature: "sig0", status: "confirmed", slot: 1, err: null },
        { signature: "sig1", status: "confirmed", slot: 2, err: null },
      ],
    });
    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection(),
      onState: () => {},
    });
    expect(state.outcomes.map((o) => o.state)).toEqual(["landed", "landed"]);
    expect(summarize(state.outcomes)).toContain("All 2 went through");
  });

  test("puts what landed into the history at once, and only what landed", async () => {
    script.confirm = async () => ({
      blockHeight: LAST_VALID + 1,
      statuses: [
        { signature: "sig0", status: "confirmed", slot: 1, err: null },
        { signature: "sig1", status: "unknown", slot: null, err: null },
      ],
    });
    await executeBundle({ request, build: bundle(), builtAt: Date.now(), connection: connection(), onState: () => {} });
    expect(script.recorded).toEqual([["sig0"]]);
  });

  test("a history that cannot be written does not hold up or spoil the result", async () => {
    script.record = () => new Promise(() => {});
    const started = Date.now();
    const state = await executeBundle({ request, build: bundle(), builtAt: Date.now(), connection: connection(), onState: () => {} });
    expect(state.phase).toBe("settled");
    expect(state.outcomes.every((o) => o.state === "landed")).toBe(true);
    // It waits a few seconds at most for the history, never forever.
    expect(Date.now() - started).toBeLessThan(5_000);

    script.record = async () => {
      throw new Error("history is down");
    };
    const again = await executeBundle({ request, build: bundle(), builtAt: Date.now(), connection: connection(), onState: () => {} });
    expect(again.phase).toBe("settled");
  });

  test("nothing is recorded when nothing landed", async () => {
    script.confirm = async () => ({
      blockHeight: LAST_VALID + 1,
      statuses: [
        { signature: "sig0", status: "unknown", slot: null, err: null },
        { signature: "sig1", status: "unknown", slot: null, err: null },
      ],
    });
    await executeBundle({ request, build: bundle(), builtAt: Date.now(), connection: connection(), onState: () => {} });
    expect(script.recorded).toEqual([]);
  });

  test("past lastValidBlockHeight an unlanded transaction is expired, not pending", async () => {
    // Without the block height there is no way to tell these apart, which is
    // why the confirm endpoint returns it.
    script.confirm = async () => ({
      blockHeight: LAST_VALID + 1,
      statuses: [
        { signature: "sig0", status: "confirmed", slot: 1, err: null },
        { signature: "sig1", status: "unknown", slot: null, err: null },
      ],
    });

    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection(),
      onState: () => {},
    });
    expect(state.outcomes[0]!.state).toBe("landed");
    expect(state.outcomes[1]!.state).toBe("expired");
    // One poll: there is nothing to wait for once the blockhash is dead.
    expect(script.confirms).toBe(1);
  });

  test("a processed transaction is pending, never expired", async () => {
    // "processed" means a node has it in a block. The blockhash stops
    // mattering at that point. Calling it expired tells the user their
    // money never moved when it did, and the obvious response to that is to
    // retry and pay twice.
    script.confirm = async () => ({
      blockHeight: LAST_VALID + 500,
      statuses: [
        { signature: "sig0", status: "processed", slot: 7, err: null },
        { signature: "sig1", status: "unknown", slot: null, err: null },
      ],
    });

    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection(),
      onState: () => {},
    });
    expect(state.outcomes[0]!.state).toBe("pending");
    // Never seen by the cluster and past the last valid height: that one is dead.
    expect(state.outcomes[1]!.state).toBe("expired");
  });

  test("an on-chain failure is reported with its decoded cause", async () => {
    script.confirm = async () => ({
      blockHeight: 900,
      statuses: [
        { signature: "sig0", status: "confirmed", slot: 1, err: null },
        { signature: "sig1", status: "failed", slot: 2, err: { InstructionError: [3, { Custom: 6001 }] } },
      ],
    });

    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection(),
      onState: () => {},
    });
    expect(state.outcomes[1]!.state).toBe("failed");
    expect(state.outcomes[1]!.error).toContain("price moved");
  });

  test("outcomes are named by the legs their transaction carried", async () => {
    script.txCount = 3;
    const state = await executeBundle({
      request,
      build: bundle(3),
      builtAt: Date.now(),
      connection: connection(),
      onState: () => {},
    });
    expect(state.outcomes.map((o) => o.symbols)).toEqual([["SYM0"], ["SYM1"], ["SYM2"]]);
  });

  test("signs every transaction in one call, so the user approves once", async () => {
    let calls = 0;
    let count = 0;
    script.txCount = 6;
    await executeBundle({
      request,
      build: bundle(6),
      builtAt: Date.now(),
      connection: connection({
        signAll: async (txs) => {
          calls++;
          count = txs.length;
          return txs.map((t) => `signed:${t}`);
        },
      }),
      onState: () => {},
    });
    expect(calls).toBe(1);
    expect(count).toBe(6);
  });

  test("reports every transition so the UI never has to guess", async () => {
    const phases: string[] = [];
    await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection(),
      onState: (patch) => {
        if (patch.phase) phases.push(patch.phase);
      },
    });
    expect(phases).toEqual(["signing", "submitting", "confirming", "settled"]);
  });

  test("buildBundle surfaces the server's refusal untouched", async () => {
    script.build = async () => {
      throw new FakeApiError(409, "nothing to trade");
    };
    await expect(buildBundle(request)).rejects.toThrow("nothing to trade");
  });
});

describe("a relay refusal", () => {
  test("says nothing was sent and leaves the flow retryable", async () => {
    // The relay verifies every signature before it sends anything, so a 4xx
    // from it means nothing reached the network.
    script.submit = async () => {
      throw new FakeApiError(400, "transactions[0] signature 0 does not sign this message");
    };
    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection({}),
      onState: () => {},
    });
    expect(state.phase).toBe("error");
    expect(state.committed).toBe(false);
    expect(state.error).toContain("Nothing was sent");
  });

  test("a dropped connection is not assumed to have sent nothing", async () => {
    script.submit = async () => {
      throw new TypeError("Failed to fetch");
    };
    const state = await executeBundle({
      request,
      build: bundle(),
      builtAt: Date.now(),
      connection: connection({}),
      onState: () => {},
    });
    expect(state.committed).toBe(true);
    expect(state.error).toContain("check What I own");
  });
});
