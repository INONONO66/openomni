import type { ResolvedExecutorOptions } from "../src/executor-contract";
import { catalogLayer, executorLayer } from "./helpers/service-layers";
import { describe, expect, test } from "bun:test";
import { stringQueryTool } from "./helpers/query-tool";
import { nth } from "./helpers/nth";
import { LedgerAction, type PlainObject, type PlainValue } from "@openomni/protocol";
import { createTurnDispatcher } from "../src/index";
import { createExecutor, } from "../src/executor";
import type { DurableExecutor, ExecutionBatchItem } from "../src/executor-contract";
import type { WaveControl } from "../src/core/execution/tool-wave";
import { CommitRefused, ForeignFailure as LedgerFailure } from "@openomni/ledger";
import { failure } from "./helpers/effect-g1";
import { Effect } from "effect";
import { isolated } from "./helpers/isolated";

import { compiledPolicy } from "./helpers/compiled-policy";

function runBatch(executor: DurableExecutor, items: readonly ExecutionBatchItem[], control: WaveControl) {
  return isolated(executor.runBatch(items, control));
}
function recover(executor: DurableExecutor) { return isolated(executor.recover()); }

function harness() {
  const actions: LedgerAction.Node[] = [];
  let sequence = 0;
  const options: ResolvedExecutorOptions = {
    identity: { sessionId: "session", role: "resident", parentActionId: "turn", turnId: "turn" },
    policy: compiledPolicy(),
    clock: () => 100,
    entropy: () => `action:${++sequence}`,
    observations: { publish: () => undefined },
    ledger: {
      actions: () => actions,
      commit: (action) => Effect.sync(() => {
        const node = LedgerAction.Node.parse({
          ...action,
          ordinal: actions.length + 1,
          prevHash: "fixture-prev",
          actionHash: "fixture-hash",
        });
        actions.push(node);
        return { action: node, revision: node.ordinal };
      }),
    },
  };
  return { actions, options };
}

function record(value: PlainValue): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function effect(action: LedgerAction.Node): PlainObject {
  const value = action.effect.value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object effect");
  return value;
}

function intentOf(action: LedgerAction.Node): PlainObject {
  const value = action.intent.value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object intent");
  return value;
}

function resultsOf(actions: readonly LedgerAction.Node[], kind: LedgerAction.Kind) {
  return actions.filter((action) => action.kind === kind && effect(action).phase === "result");
}

function openIntent(
  id: string,
  kind: LedgerAction.Kind,
  parentId: string,
  intent: PlainObject,
): LedgerAction.Append {
  return {
    id,
    parentId,
    sessionId: "session",
    kind,
    ts: 1,
    intent: { encodingVersion: 1, value: { phase: "intent", ...intent } },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
  };
}

/** The chat result row that settles the open intent `intentId`. */
function settledResult(
  intentId: string,
  kind: LedgerAction.Kind,
  effect: PlainObject,
): LedgerAction.Append {
  return {
    id: `${intentId}-result`,
    parentId: intentId,
    sessionId: "session",
    kind,
    ts: 2,
    intent: { encodingVersion: 1, value: { phase: "result", op: "chat" } },
    effect: { encodingVersion: 1, value: { phase: "result", ...effect } },
    irreversible: true,
  };
}

const toolRequest = {
  kind: "tool",
  op: "write",
  intent: { path: "a" },
  effect: { category: "mutation" },
  toolObservation: { turnId: "turn", callId: "call-1" },
} as const;

/** A post-phase denial of every write: the terminal is blocked_post, never re-decided. */
const denyWritePost: Parameters<typeof compiledPolicy>[0] = [
  {
    name: "deny-write-post",
    kind: "tool",
    phase: "post",
    match: { encodingVersion: 1, value: { op: "write" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "post_denied" } },
    priority: 500,
    generation: 1,
  },
];

describe("completion recovery", () => {
  for (const site of ["before_persist", "after_persist"] as const) {
    test(`a result commit throwing ${site} keeps one terminal and never replays the body`, async () => {
      const { actions, options } = harness();
      const commit = options.ledger.commit;
      let injected = false;
      // Lose the executed terminal's commit once, before or after it persisted.
      const storageLost = new LedgerFailure({ operation: "commit", cause: "storage_lost" });
      const lose = (action: LedgerAction.Append) => Effect.gen(function* () {
        injected = true;
        if (site === "after_persist") yield* commit(action);
        return yield* storageLost;
      });
      const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
        ...options,
        ledger: {
          ...options.ledger,
          commit: (action) =>
            !injected &&
            action.kind === "tool" &&
            record(action.effect.value).terminal === "executed"
              ? lose(action)
              : commit(action),
        },
      }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
      let bodies = 0;
      const error = await isolated(failure(executor.runBatch(
        [{ request: toolRequest, body: () => Effect.sync(() => {
          bodies += 1;
          return { status: "success", output: "written" };
        }) }],
        { signal: new AbortController().signal },
      )));
      expect(error).toMatchObject({ _tag: "CommitFailed", error: storageLost });
      expect(bodies).toBe(1);
      expect(resultsOf(actions, "tool")).toHaveLength(site === "after_persist" ? 1 : 0);
      await recover(executor);
      const terminals = resultsOf(actions, "tool");
      expect(terminals).toHaveLength(1);
      if (site === "after_persist") {
        expect(effect(nth(terminals, 0))).toMatchObject({ terminal: "executed", result: { status: "success", output: "written" } });
      } else {
        expect(effect(nth(terminals, 0))).toMatchObject({
          terminal: "outcome_unknown",
          callId: "call-1",
          error: { name: "ProcessLost" },
          recovery: {
            site: "crash",
            classification: "ambiguous_no_replay",
            proof: "indeterminate",
            rawSettled: false,
            revertReceipt: null,
          },
        });
      }
      const before = structuredClone(actions);
      await recover(executor);
      expect(actions).toEqual(before);
      expect(bodies).toBe(1);
    });
  }

  test("a throwing model-facing projection preserves the executed body's evidence", async () => {
    const { actions, options } = harness();
    const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = options; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
    const results = await runBatch(executor,
      [
        {
          request: {
            ...toolRequest,
            toolResult: () => {
              throw new Error("projection_failed");
            },
          },
          body: () => Effect.succeed({ status: "success", output: "written" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expect(results[0]).toMatchObject({ terminal: "executed", failure: { _tag: "ForeignFailure" } });
    expect(effect(nth(resultsOf(actions, "tool"), 0))).toMatchObject({
      terminal: "executed",
      disposition: "irreversible",
      result: { status: "success", output: "written" },
      evidence: { failures: [], defects: [{ name: "Error", cause: "projection_failed" }], interrupted: false },
    });
    expect(effect(nth(resultsOf(actions, "tool"), 0)).toolResult).toBeUndefined();
  });

  test("a refused post decision propagates without a fabricated verdict and recovers without replay", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
      ...options,
      ledger: {
        ...options.ledger,
        commit: (action) =>
          action.kind === "policy.decision" && record(action.intent.value).hook === "tool.post"
            ? Effect.fail(new LedgerFailure({ operation: "commit", cause: "decision_lost" }))
            : commit(action),
      },
    }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
    let bodies = 0;
    const error = await isolated(failure(executor.runBatch(
      [{ request: toolRequest, body: () => Effect.sync(() => { bodies += 1; return { status: "success" }; }) }],
      { signal: new AbortController().signal },
    )));
    expect(error).toMatchObject({ _tag: "CommitFailed", error: { _tag: "ForeignFailure", cause: "decision_lost" } });
    expect(actions.filter((action) => action.kind === "policy.decision")).toHaveLength(1);
    expect(resultsOf(actions, "tool")).toHaveLength(0);
    await recover(executor);
    expect(resultsOf(actions, "tool")).toHaveLength(1);
    expect(effect(nth(resultsOf(actions, "tool"), 0))).toMatchObject({
      terminal: "outcome_unknown",
      recovery: { site: "crash", proof: "indeterminate" },
    });
    expect(actions.filter((action) => action.kind === "policy.decision")).toHaveLength(1);
    expect(bodies).toBe(1);
  });

  test("a blocked_post terminal lost after persistence survives recovery without re-deciding or reverting twice", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    let injected = false;
    const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
      ...options,
      policy: compiledPolicy(denyWritePost),
      ledger: {
        ...options.ledger,
        commit: (action) => Effect.gen(function* () {
          const receipt = yield* commit(action);
          if (action.kind === "tool" && effect(receipt.action).terminal === "blocked_post" && !injected) {
            injected = true;
            return yield* new LedgerFailure({ operation: "commit", cause: "storage_lost" });
          }
          return receipt;
        }),
      },
    }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
    let reverted = 0;
    const error = await isolated(failure(executor.runBatch(
      [{
        request: { ...toolRequest, revert: () => Effect.sync(() => { reverted += 1; }) },
        body: () => Effect.succeed({ status: "success" }),
      }],
      { signal: new AbortController().signal },
    )));
    expect(reverted).toBe(1);
    expect(error).toMatchObject({ _tag: "CommitFailed", error: { _tag: "ForeignFailure", cause: "storage_lost" } });
    const before = structuredClone(actions);
    await recover(executor);
    expect(actions).toEqual(before);
    expect(reverted).toBe(1);
    const terminals = resultsOf(actions, "tool");
    expect(terminals).toHaveLength(1);
    expect(effect(nth(terminals, 0))).toMatchObject({
      terminal: "blocked_post",
      disposition: "reverted",
      reason: "post_denied",
    });
  });

  test("a throwing reverter is never proof of rollback", async () => {
    const { actions, options } = harness();
    const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = { ...options, policy: compiledPolicy(denyWritePost) }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
    const results = await runBatch(executor,
      [
        {
          request: {
            ...toolRequest,
            revert: () => Effect.die(new Error("revert_failed")),
          },
          body: () => Effect.succeed({ status: "success" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expect(results[0]).toMatchObject({ terminal: "executed", failure: { _tag: "ForeignFailure" } });
    expect(effect(nth(resultsOf(actions, "tool"), 0))).toMatchObject({
      terminal: "executed",
      disposition: "irreversible",
      result: { status: "success" },
      evidence: { failures: [], defects: [{ name: "Error", cause: "revert_failed" }], interrupted: false },
    });
  });

  test("a refused recovery commit stays pending: the typed refusal propagates and nothing is appended blindly", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    const stale = new CommitRefused({ sessionId: "session", reason: "fence", expectedRevision: 1, currentRevision: 1, fence: 1, currentFence: 2 });
    let bodyDone = false;
    const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
      ...options,
      ledger: {
        ...options.ledger,
        commit: (action) => bodyDone ? Effect.fail(stale) : commit(action),
      },
    }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
    const run = executor.runBatch(
      [
        {
          request: toolRequest,
          body: () => Effect.sync(() => {
            bodyDone = true;
            return { status: "success" };
          }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expect(await isolated(failure(run))).toMatchObject({ _tag: "CommitFailed", error: stale });
    const before = structuredClone(actions);
    expect(await isolated(failure(executor.recover()))).toMatchObject({ _tag: "CommitFailed", error: stale });
    expect(actions).toEqual(before);
    expect(resultsOf(actions, "tool")).toHaveLength(0);
    expect(actions.filter((action) => action.kind === "tool")).toHaveLength(1);
  });
});

describe("crash-open recovery", () => {
  test("classification is pinned on the intent and defaults by kind", async () => {
    const { actions, options } = harness();
    const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = options; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
    await runBatch(executor,
      [
        { request: toolRequest, body: () => Effect.succeed({ status: "success" }) },
        {
          request: { ...toolRequest, op: "poll", recovery: "endpoint_idempotent" },
          body: () => Effect.succeed({ status: "success" }),
        },
        {
          request: { kind: "message", op: "assistant", intent: {}, effect: {} },
          body: () => Effect.succeed({ text: "hi" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    const intents = actions.filter((action) => intentOf(action).phase === "intent");
    expect(intents.map((action) => intentOf(action).recovery)).toEqual([
      "ambiguous_no_replay",
      "endpoint_idempotent",
      "local_transactional",
    ]);
  });

  test("an ordinary open tool settles outcome_unknown once, with no body and an unknown settlement", async () => {
    const { actions, options } = harness();
    await isolated(options.ledger.commit(
      openIntent("lost-tool", "tool", "turn", {
        op: "bash",
        turnId: "turn",
        callId: "call-9",
        waveId: "lost-tool",
        value: {},
        effect: { category: "execution" },
      }),
    ));
    const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = options; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
    await recover(executor);
    expect(actions).toHaveLength(2);
    expect(effect(nth(actions, 1))).toMatchObject({
      terminal: "outcome_unknown",
      callId: "call-9",
      error: { name: "ProcessLost" },
      toolResult: { toolCallId: "call-9", toolName: "bash", isError: true, settlement: "unknown" },
      recovery: {
        site: "crash",
        classification: "ambiguous_no_replay",
        proof: "indeterminate",
        proofReceipt: null,
        rawSettled: false,
      },
    });
    await recover(executor);
    expect(actions).toHaveLength(2);
  });

  test("a request-bearing wave is left to its captured dispatcher", async () => {
    const { actions, options } = harness();
    await isolated(options.ledger.commit(
      openIntent("guarded", "tool", "turn", {
        op: "send",
        turnId: "turn",
        callId: "call-g",
        waveId: "guarded",
        approvalRequired: true,
        value: {},
        effect: {},
      }),
    ));
    await isolated(options.ledger.commit(
      openIntent("sibling", "tool", "turn", {
        op: "read",
        turnId: "turn",
        callId: "call-s",
        waveId: "guarded",
        approvalRequired: false,
        value: {},
        effect: {},
      }),
    ));
    await recover(Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = options; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); })));
    expect(actions).toHaveLength(2);
  });

  test("other turns and already-settled intents are untouched", async () => {
    const { actions, options } = harness();
    await isolated(options.ledger.commit(
      openIntent("other", "tool", "turn-2", {
        op: "bash",
        turnId: "turn-2",
        waveId: "other",
        value: {},
        effect: {},
      }),
    ));
    await isolated(options.ledger.commit(openIntent("done", "llm", "turn", { op: "chat", value: {} })));
    await isolated(options.ledger.commit(settledResult("done", "llm", { terminal: "executed", effect: {} })));
    await recover(Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = options; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); })));
    expect(actions).toHaveLength(3);
  });

  test("a lost provider attempt makes the logical llm outcome_unknown, never a silent retry", async () => {
    const { actions, options } = harness();
    await isolated(options.ledger.commit(openIntent("lost-llm", "llm", "turn", { op: "chat", value: {} })));
    await isolated(options.ledger.commit(
      openIntent("attempt-1", "attempt", "lost-llm", { op: "chat", value: { attempt: 1 } }),
    ));
    await recover(Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = options; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); })));
    expect(
      actions.map((action) => [action.kind, action.parentId, effect(action).terminal]),
    ).toEqual([
      ["llm", "turn", undefined],
      ["attempt", "lost-llm", undefined],
      ["attempt", "attempt-1", "outcome_unknown"],
      ["llm", "lost-llm", "outcome_unknown"],
    ]);
    expect(effect(nth(actions, 3))).toMatchObject({
      recovery: { classification: "ambiguous_no_replay", proof: "indeterminate" },
    });
  });

  test("an llm whose attempts all settled is interrupted from that evidence under a resume parent", async () => {
    const { actions, options } = harness();
    await isolated(options.ledger.commit({
      id: "resume-1",
      parentId: "turn",
      sessionId: "session",
      kind: "turn",
      ts: 1,
      intent: { encodingVersion: 1, value: { phase: "resume", turnId: "turn", resultId: "r" } },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      irreversible: true,
    }));
    await isolated(options.ledger.commit(openIntent("llm-2", "llm", "resume-1", { op: "chat", value: {} })));
    await isolated(options.ledger.commit(
      openIntent("attempt-2", "attempt", "llm-2", { op: "chat", value: { attempt: 1 } }),
    ));
    await isolated(options.ledger.commit(
      settledResult("attempt-2", "attempt", {
        terminal: "executed",
        effect: {},
        evidence: { failures: [{ tag: "ForeignFailure", operation: "chat", cause: "APIError" }], defects: [], interrupted: false },
      }),
    ));
    await recover(Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = options; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); })));
    expect(actions).toHaveLength(5);
    expect(actions[4]).toMatchObject({ kind: "llm", parentId: "llm-2" });
    expect(effect(nth(actions, 4))).toMatchObject({
      terminal: "interrupted",
      recovery: {
        site: "crash",
        classification: "local_transactional",
        proof: "absent",
        proofReceipt: { id: "attempt-2-result" },
      },
    });
  });

  test("kernel-local projections are interrupted from ledger read-back instead of staying ambiguous", async () => {
    const { actions, options } = harness();
    await isolated(options.ledger.commit(
      openIntent("msg", "message", "turn", { op: "assistant", value: {} }),
    ));
    await isolated(options.ledger.commit(
      openIntent("cut", "compaction", "turn", {
        op: "compact",
        value: {},
        recovery: "local_transactional",
      }),
    ));
    await recover(Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = options; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); })));
    expect(resultsOf(actions, "message").map((action) => effect(action).terminal)).toEqual([
      "interrupted",
    ]);
    expect(effect(nth(resultsOf(actions, "compaction"), 0))).toMatchObject({
      terminal: "interrupted",
      recovery: {
        classification: "local_transactional",
        proof: "absent",
        proofReceipt: { id: "cut" },
      },
    });
  });
});

describe("turn dispatcher recovery", () => {
  test("settles the executor's crash-open evidence before captured waves, without running tools", async () => {
    const { actions, options } = harness();
    await isolated(options.ledger.commit(
      openIntent("lost-echo", "tool", "turn", {
        op: "echo",
        turnId: "turn",
        callId: "call-e",
        waveId: "lost-echo",
        value: {},
        effect: {},
      }),
    ));
    let executions = 0;
    const dispatcher = createTurnDispatcher(
      {
        sessionId: "session",
        role: "resident",
        actionId: "turn",
        turnId: "turn",
        ledger: options.ledger,
      },
      {},
    ).pipe(Effect.provide(catalogLayer([stringQueryTool("echo", "echo", async () => {
      executions += 1;
      return "ok";
    })])), Effect.provide(executorLayer(options)));
    await isolated(Effect.flatMap(dispatcher, (value) => value.executor.recover()));
    expect(executions).toBe(0);
    expect(effect(nth(actions, 1))).toMatchObject({
      terminal: "outcome_unknown",
      callId: "call-e",
    });
  });
});
