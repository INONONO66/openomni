import { describe, expect, test } from "bun:test";
import { nth } from "./helpers/nth";
import { LedgerAction, type PlainObject, type PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { createTurnDispatcher, defineTool } from "../src/index";
import { createExecutor, type ExecutorOptions } from "../src/executor";
import { compiledPolicy } from "./helpers/compiled-policy";

function harness() {
  const actions: LedgerAction.Node[] = [];
  let sequence = 0;
  const options: ExecutorOptions = {
    identity: { sessionId: "session", role: "resident", parentActionId: "turn", turnId: "turn" },
    policy: compiledPolicy(),
    clock: () => 100,
    entropy: () => `action:${++sequence}`,
    observations: { publish: () => undefined },
    ledger: {
      actions: () => actions,
      async commit(action) {
        const node = LedgerAction.Node.parse({ ...action, ordinal: actions.length + 1 });
        actions.push(node);
        return { action: node, revision: node.ordinal };
      },
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
      const lose = async (action: LedgerAction.Append) => {
        injected = true;
        if (site === "after_persist") await commit(action);
        throw new Error("storage_lost");
      };
      const executor = createExecutor({
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
      });
      let bodies = 0;
      const results = await executor.runBatch(
        [
          {
            request: toolRequest,
            body: async () => {
              bodies += 1;
              return { status: "success", output: "written" };
            },
          },
        ],
        { signal: new AbortController().signal },
      );
      expect(bodies).toBe(1);
      const terminals = resultsOf(actions, "tool");
      expect(terminals).toHaveLength(1);
      if (site === "after_persist") {
        expect(results[0]?.terminal).toBe("executed");
        expect(effect(nth(terminals, 0))).toMatchObject({ terminal: "executed" });
      } else {
        expect(results[0]).toMatchObject({
          terminal: "failed",
          error: { message: "storage_lost" },
        });
        expect(effect(nth(terminals, 0))).toMatchObject({
          terminal: "failed",
          disposition: "irreversible",
          callId: "call-1",
          error: { name: "Error" },
          recovery: {
            site: "result_commit",
            classification: "ambiguous_no_replay",
            proof: "applied",
            rawSettled: true,
            revertReceipt: null,
          },
        });
      }
      const before = structuredClone(actions);
      await executor.recover();
      expect(actions).toEqual(before);
      expect(bodies).toBe(1);
    });
  }

  test("a throwing model-facing projection settles failed at result_commit with the body's evidence", async () => {
    const { actions, options } = harness();
    const executor = createExecutor(options);
    const results = await executor.runBatch(
      [
        {
          request: {
            ...toolRequest,
            toolResult: () => {
              throw new Error("projection_failed");
            },
          },
          body: async () => ({ status: "success", output: "written" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expect(results[0]).toMatchObject({
      terminal: "failed",
      error: { message: "projection_failed" },
    });
    expect(effect(nth(resultsOf(actions, "tool"), 0))).toMatchObject({
      terminal: "failed",
      recovery: { site: "result_commit", proof: "applied" },
    });
    expect(effect(nth(resultsOf(actions, "tool"), 0)).toolResult).toBeUndefined();
  });

  test("a throwing post decision is recovered at post_policy without a fabricated verdict", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    const executor = createExecutor({
      ...options,
      ledger: {
        ...options.ledger,
        async commit(action) {
          if (action.kind === "policy.decision" && record(action.intent.value).hook === "tool.post")
            throw new Error("decision_lost");
          return commit(action);
        },
      },
    });
    const results = await executor.runBatch(
      [{ request: toolRequest, body: async () => ({ status: "success" }) }],
      { signal: new AbortController().signal },
    );
    expect(results[0]).toMatchObject({ terminal: "failed", error: { message: "decision_lost" } });
    expect(actions.filter((action) => action.kind === "policy.decision")).toHaveLength(1);
    expect(effect(nth(resultsOf(actions, "tool"), 0))).toMatchObject({
      terminal: "failed",
      disposition: "irreversible",
      recovery: { site: "post_policy", proof: "applied" },
    });
  });

  test("a blocked_post terminal lost after persistence is projected back from the ledger, not re-decided", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    let injected = false;
    const executor = createExecutor({
      ...options,
      policy: compiledPolicy(denyWritePost),
      ledger: {
        ...options.ledger,
        async commit(action) {
          const receipt = await commit(action);
          if (
            action.kind === "tool" &&
            effect(receipt.action).terminal === "blocked_post" &&
            !injected
          ) {
            injected = true;
            throw new Error("storage_lost");
          }
          return receipt;
        },
      },
    });
    let reverted = 0;
    const results = await executor.runBatch(
      [
        {
          request: {
            ...toolRequest,
            revert: () => {
              reverted += 1;
            },
          },
          body: async () => ({ status: "success" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expect(reverted).toBe(1);
    expect(results[0]).toEqual({
      terminal: "blocked_post",
      disposition: "reverted",
      reason: "post_denied",
    });
    const terminals = resultsOf(actions, "tool");
    expect(terminals).toHaveLength(1);
    expect(effect(nth(terminals, 0))).toMatchObject({
      terminal: "blocked_post",
      disposition: "reverted",
    });
  });

  test("a throwing reverter is never proof of rollback", async () => {
    const { actions, options } = harness();
    const executor = createExecutor({ ...options, policy: compiledPolicy(denyWritePost) });
    const results = await executor.runBatch(
      [
        {
          request: {
            ...toolRequest,
            revert: () => {
              throw new Error("revert_failed");
            },
          },
          body: async () => ({ status: "success" }),
        },
      ],
      { signal: new AbortController().signal },
    );
    expect(results[0]).toMatchObject({ terminal: "failed", error: { message: "revert_failed" } });
    expect(effect(nth(resultsOf(actions, "tool"), 0))).toMatchObject({
      terminal: "failed",
      disposition: "irreversible",
      recovery: { site: "reverter", proof: "applied", revertReceipt: null },
    });
  });

  test("a refused recovery commit stays pending: the typed refusal propagates and nothing is appended blindly", async () => {
    const { actions, options } = harness();
    const commit = options.ledger.commit;
    class StaleWriter extends Error {
      readonly code = "stale";
    }
    let bodyDone = false;
    const executor = createExecutor({
      ...options,
      ledger: {
        ...options.ledger,
        async commit(action) {
          if (bodyDone) throw new StaleWriter("stale");
          return commit(action);
        },
      },
    });
    const run = executor.runBatch(
      [
        {
          request: toolRequest,
          body: async () => {
            bodyDone = true;
            return { status: "success" };
          },
        },
      ],
      { signal: new AbortController().signal },
    );
    await expect(run).rejects.toBeInstanceOf(StaleWriter);
    expect(resultsOf(actions, "tool")).toHaveLength(0);
    expect(actions.filter((action) => action.kind === "tool")).toHaveLength(1);
  });
});

describe("crash-open recovery", () => {
  test("classification is pinned on the intent and defaults by kind", async () => {
    const { actions, options } = harness();
    const executor = createExecutor(options);
    await executor.runBatch(
      [
        { request: toolRequest, body: async () => ({ status: "success" }) },
        {
          request: { ...toolRequest, op: "poll", recovery: "endpoint_idempotent" },
          body: async () => ({ status: "success" }),
        },
        {
          request: { kind: "message", op: "assistant", intent: {}, effect: {} },
          body: async () => ({ text: "hi" }),
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
    await options.ledger.commit(
      openIntent("lost-tool", "tool", "turn", {
        op: "bash",
        turnId: "turn",
        callId: "call-9",
        waveId: "lost-tool",
        value: {},
        effect: { category: "execution" },
      }),
    );
    const executor = createExecutor(options);
    await executor.recover();
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
    await executor.recover();
    expect(actions).toHaveLength(2);
  });

  test("a request-bearing wave is left to its captured dispatcher", async () => {
    const { actions, options } = harness();
    await options.ledger.commit(
      openIntent("guarded", "tool", "turn", {
        op: "send",
        turnId: "turn",
        callId: "call-g",
        waveId: "guarded",
        approvalRequired: true,
        value: {},
        effect: {},
      }),
    );
    await options.ledger.commit(
      openIntent("sibling", "tool", "turn", {
        op: "read",
        turnId: "turn",
        callId: "call-s",
        waveId: "guarded",
        approvalRequired: false,
        value: {},
        effect: {},
      }),
    );
    await createExecutor(options).recover();
    expect(actions).toHaveLength(2);
  });

  test("other turns and already-settled intents are untouched", async () => {
    const { actions, options } = harness();
    await options.ledger.commit(
      openIntent("other", "tool", "turn-2", {
        op: "bash",
        turnId: "turn-2",
        waveId: "other",
        value: {},
        effect: {},
      }),
    );
    await options.ledger.commit(openIntent("done", "llm", "turn", { op: "chat", value: {} }));
    await options.ledger.commit(settledResult("done", "llm", { terminal: "executed", effect: {} }));
    await createExecutor(options).recover();
    expect(actions).toHaveLength(3);
  });

  test("a lost provider attempt makes the logical llm outcome_unknown, never a silent retry", async () => {
    const { actions, options } = harness();
    await options.ledger.commit(openIntent("lost-llm", "llm", "turn", { op: "chat", value: {} }));
    await options.ledger.commit(
      openIntent("attempt-1", "attempt", "lost-llm", { op: "chat", value: { attempt: 1 } }),
    );
    await createExecutor(options).recover();
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

  test("an llm whose attempts all settled fails from that evidence under a resume parent", async () => {
    const { actions, options } = harness();
    await options.ledger.commit({
      id: "resume-1",
      parentId: "turn",
      sessionId: "session",
      kind: "turn",
      ts: 1,
      intent: { encodingVersion: 1, value: { phase: "resume", turnId: "turn", resultId: "r" } },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      irreversible: true,
    });
    await options.ledger.commit(openIntent("llm-2", "llm", "resume-1", { op: "chat", value: {} }));
    await options.ledger.commit(
      openIntent("attempt-2", "attempt", "llm-2", { op: "chat", value: { attempt: 1 } }),
    );
    await options.ledger.commit(
      settledResult("attempt-2", "attempt", {
        terminal: "failed",
        effect: {},
        error: { name: "APIError" },
      }),
    );
    await createExecutor(options).recover();
    expect(actions).toHaveLength(5);
    expect(actions[4]).toMatchObject({ kind: "llm", parentId: "llm-2" });
    expect(effect(nth(actions, 4))).toMatchObject({
      terminal: "failed",
      recovery: {
        site: "crash",
        classification: "local_transactional",
        proof: "absent",
        proofReceipt: { id: "attempt-2-result" },
      },
    });
  });

  test("kernel-local projections fail from the ledger read-back instead of staying ambiguous", async () => {
    const { actions, options } = harness();
    await options.ledger.commit(
      openIntent("msg", "message", "turn", { op: "assistant", value: {} }),
    );
    await options.ledger.commit(
      openIntent("cut", "compaction", "turn", {
        op: "compact",
        value: {},
        recovery: "local_transactional",
      }),
    );
    await createExecutor(options).recover();
    expect(resultsOf(actions, "message").map((action) => effect(action).terminal)).toEqual([
      "failed",
    ]);
    expect(effect(nth(resultsOf(actions, "compaction"), 0))).toMatchObject({
      terminal: "failed",
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
    await options.ledger.commit(
      openIntent("lost-echo", "tool", "turn", {
        op: "echo",
        turnId: "turn",
        callId: "call-e",
        waveId: "lost-echo",
        value: {},
        effect: {},
      }),
    );
    let executions = 0;
    const dispatcher = createTurnDispatcher(
      [
        defineTool({
          name: "echo",
          description: "echo",
          category: "query",
          input: z.object({}).strict(),
          output: z.string(),
          visibility: { model: ["resident"], cell: ["resident"] },
          execute: async () => {
            executions += 1;
            return "ok";
          },
          render: (_input, value: PlainValue) => String(value),
        }),
      ],
      {
        sessionId: "session",
        role: "resident",
        actionId: "turn",
        turnId: "turn",
        policy: compiledPolicy(),
        ledger: options.ledger,
      },
      { observations: { publish: () => undefined }, clock: () => 1, entropy: options.entropy },
    );
    await dispatcher.executor.recover();
    expect(executions).toBe(0);
    expect(effect(nth(actions, 1))).toMatchObject({
      terminal: "outcome_unknown",
      callId: "call-e",
    });
  });
});
