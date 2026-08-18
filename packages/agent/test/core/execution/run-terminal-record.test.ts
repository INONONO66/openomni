import { describe, expect, it } from "bun:test";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { runAgent } from "../../../src/core/execution/run";
import type { PolicyEngineRegistration } from "../../../src/core/policy";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

/**
 * Every run that started has to end on the record too.
 *
 * `agent.run.started` fires unconditionally, but the terminal used to be
 * emitted by whichever branch happened to end the run — and only three of them
 * did. A run a policy blocked emitted a start and nothing after it, so anything
 * folding the stream saw it as permanently in flight.
 */
async function runWith(
  middleware: PolicyEngineRegistration[],
  budget?: { readonly maxTurns: number },
): Promise<string[]> {
  const seen: string[] = [];
  const stop = Bus.observe((event, payload) => {
    if (event.name !== Operational.Events.Info.name) return;
    const msg = (payload as { msg?: string }).msg;
    if (msg === "agent.run.started" || msg === "agent.run.completed") seen.push(msg);
  });
  try {
    await runAgent(runInput([{ role: "user", content: "hi" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      ...(budget === undefined ? {} : { budget }),
      middleware,
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => createStopOutcome(),
      }),
    });
  } finally {
    stop();
  }
  return seen;
}

type BlockablePoint =
  | "run.lifecycle.pre"
  | "run.turn.pre"
  | "connection.llm.pre"
  | "connection.llm.post";

function blockAt(point: BlockablePoint): PolicyEngineRegistration {
  return {
    kind: "point",
    name: `test:block-${point}`,
    pointIds: [point],
    effectCapabilities: { [point]: ["run.abort"] },
    priority: 100,
    fn: () =>
      PolicyDecision.deny({
        policyId: "test.block",
        reasonCodes: ["blocked"],
        effects: [{ type: "run.abort", reason: "blocked" }],
      }),
  } as PolicyEngineRegistration;
}

describe("a started run always records a terminal", () => {
  it("on the ordinary path", async () => {
    expect(await runWith([])).toEqual(["agent.run.started", "agent.run.completed"]);
  });

  it("when a policy blocks the run before its first turn", async () => {
    expect(await runWith([blockAt("run.lifecycle.pre")])).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });

  it("when a policy blocks the turn", async () => {
    expect(await runWith([blockAt("run.turn.pre")])).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });

  it("when a policy blocks the model request", async () => {
    expect(await runWith([blockAt("connection.llm.pre")])).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });

  it("when a policy aborts on the model response", async () => {
    expect(await runWith([blockAt("connection.llm.post")])).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });

  /**
   * The one terminal this change *moved* rather than added — it lived in
   * `dispatchBudgetCheck` before. Nothing asserted it on either side, so
   * dropping it during the move would have left the whole suite green.
   */
  it("when the turn budget is exhausted", async () => {
    expect(await runWith([], { maxTurns: 0 })).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });

  /**
   * The error path's own terminal: a `run.error.error` policy that aborts
   * settles the run rather than rethrowing, so it returns a result and must
   * record like any other exit.
   *
   * The one remaining exit without a case is the `compact` outcome, which no
   * llm run produces — it is dead alongside `Run.Outcome.compact`, whose
   * deletion is the Owner-gated item recorded in #624.
   */
  it("when a guard aborts the run on error", async () => {
    const seen: string[] = [];
    const stop = Bus.observe((event, payload) => {
      if (event.name !== Operational.Events.Info.name) return;
      const msg = (payload as { msg?: string }).msg;
      if (msg === "agent.run.started" || msg === "agent.run.completed") seen.push(msg);
    });
    try {
      await runAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        middleware: [
          {
            kind: "point",
            name: "test:abort-on-error",
            pointIds: ["run.error.error"],
            effectCapabilities: { "run.error.error": ["run.abort"] },
            priority: 100,
            fn: () =>
              PolicyDecision.deny({
                policyId: "test.abort-on-error",
                reasonCodes: ["blocked"],
                effects: [{ type: "run.abort", reason: "blocked" }],
              }),
          },
        ],
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => {
            throw new Error("transient provider hiccup");
          },
        }),
      });
    } finally {
      stop();
    }

    expect(seen).toEqual(["agent.run.started", "agent.run.completed"]);
  });

  /**
   * The two paths #631 left open. Both raise from a place that runs *after*
   * `handleError` decided, so neither reached the record the decision would
   * have produced — an abort from inside `Retry.sleep`, and a throw that is
   * not an `Error` and so is rethrown untouched. The runner owns both
   * terminals now, so both are recorded (#632).
   */
  async function runThrowing(
    run: () => Promise<never>,
    signal?: AbortSignal,
    middleware: PolicyEngineRegistration[] = [],
  ): Promise<{
    readonly seen: string[];
    readonly thrown: unknown;
    readonly failures: Array<{ context?: Record<string, unknown> }>;
  }> {
    const seen: string[] = [];
    const failures: Array<{ context?: Record<string, unknown> }> = [];
    const stop = Bus.observe((event, payload) => {
      const msg = (payload as { msg?: string }).msg;
      if (msg === "agent.run.started") seen.push(msg);
      if (event.name === Operational.Events.Error.name && msg === "agent.run.failed") {
        seen.push(msg);
        failures.push(payload as { context?: Record<string, unknown> });
      }
    });
    let thrown: unknown;
    try {
      await runAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        ...(signal === undefined ? {} : { signal }),
        middleware,
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run,
        }),
      });
    } catch (error) {
      thrown = error;
    } finally {
      stop();
    }
    return { seen, thrown, failures };
  }

  it("when the run is aborted while sleeping out a retry backoff", async () => {
    const controller = new AbortController();
    // The abort lands DURING the backoff sleep: it fires deterministically
    // the moment the retry is promised (`agent.error.retry` observed), after
    // the retry was honestly decided for a transient timeout. The ceiling is
    // narrowed so the decided facts and what could be re-derived from the
    // abort differ: decided says 2, re-derived would say the configured 3.
    const stopAbortTrigger = Bus.observe((event) => {
      if (event.name === "agent.error.retry") controller.abort();
    });
    let result: Awaited<ReturnType<typeof runThrowing>>;
    try {
      result = await runThrowing(
        async () => {
          throw new Error("connection timeout");
        },
        controller.signal,
        [
          {
            kind: "point",
            name: "test:narrow-retries",
            pointIds: ["run.error.error"],
            effectCapabilities: { "run.error.error": ["run.retry_after"] },
            priority: 100,
            fn: () =>
              PolicyDecision.allow({
                policyId: "test.narrow-retries",
                effects: [{ type: "run.retry_after", delayMs: 5_000, maxRetries: 2 }],
              }),
          } as PolicyEngineRegistration,
        ],
      );
    } finally {
      stopAbortTrigger();
    }
    const { seen, thrown, failures } = result;

    expect(thrown).toBeInstanceOf(Error);
    expect(seen).toEqual(["agent.run.started", "agent.run.failed"]);
    // The reason and ceiling decided before the wait, not ones re-derived
    // from the abort — otherwise the terminal contradicts this run's own
    // `agent.error.retry`, which reported `timeout` at attempt 1 of 2.
    expect(failures[0]?.context).toMatchObject({
      reason: "timeout",
      attempt: 1,
      maxAttempts: 2,
    });
  });

  /**
   * Audit M4: an abort that is already in force when the error is handled is
   * non-retryable BY IDENTITY. It must not emit `agent.error.retry` (a retry
   * promise the run cannot keep — it used to, then died in `Retry.sleep`),
   * and the terminal reports "aborted", not the old substring-derived
   * "timeout".
   */
  it("when the run is aborted before the retry decision: no retry promised, honest reason", async () => {
    const controller = new AbortController();
    const retryEvents: unknown[] = [];
    const stopRetryObserver = Bus.observe((event, payload) => {
      if (event.name === "agent.error.retry") retryEvents.push(payload);
    });
    let thrown: unknown;
    let seen: string[] = [];
    let failures: Array<{ context?: Record<string, unknown> }> = [];
    try {
      ({ seen, thrown, failures } = await runThrowing(async () => {
        controller.abort();
        throw new Error("connection timeout");
      }, controller.signal));
    } finally {
      stopRetryObserver();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(seen).toEqual(["agent.run.started", "agent.run.failed"]);
    expect(retryEvents).toHaveLength(0);
    expect(failures[0]?.context).toMatchObject({
      reason: "aborted",
      attempt: 1,
      maxAttempts: 3,
    });
  });

  it("when something throws a value that is not an Error", async () => {
    const { seen, thrown, failures } = await runThrowing(async () => {
      // The point of the case: the runner must record a terminal even for a
      // throw it cannot narrow to `Error`.
      // biome-ignore lint/style/useThrowOnlyError: that is the subject here
      throw "a plain string blow-up";
    });

    expect(thrown).toBe("a plain string blow-up");
    expect(seen).toEqual(["agent.run.started", "agent.run.failed"]);
    // Nothing decided a reason for this one, so the record says what the
    // throw itself supports.
    expect(failures[0]?.context).toMatchObject({ attempt: 1, maxAttempts: 3 });
  });
});
