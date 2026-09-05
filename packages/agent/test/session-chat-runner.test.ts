import { describe, expect, it, spyOn } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Retry as LlmRetry } from "@openomni/llm";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import type { LedgerAction } from "@openomni/protocol";
import {
  Bus,
  closeSessions,
  createExecutor,
  createSessionChatRunner,
  createTurnDispatcher,
  noopSink,
  session,
  type AgentExecutionLifecycle,
  type Executor,
  type SessionRunnerInput,
  type SessionRuntime,
} from "../src/index";
import { allowAllPolicy, recordingLedger } from "./helpers/compiled-policy";
import {
  createMockLlmConfig,
  createStopOutcome,
  type MockLlmFn,
  mockProviderData,
  mockProviderModel,
} from "./helpers/mock-llm";

const policy = compilePolicySnapshot({
  generation: 0,
  rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 0 })),
});

const directExecution: AgentExecutionLifecycle = {
  async runAttempt(_parent, _request, body) {
    return body();
  },
};

function input(
  boundary: SessionRunnerInput["boundary"],
  messages: SessionRunnerInput["messages"] = [{ role: "user", text: "initial" }],
): SessionRunnerInput {
  return {
    sessionId: "session-1",
    role: "resident",
    turnId: "turn-1",
    actionId: "action-1",
    ledger: {
      commit: async () => {
        throw new Error("session runner fixture does not commit ledger actions");
      },
    },
    policy,
    execution: directExecution,
    resultId: "result-1",
    parentActionId: null,
    boundaryActionId: null,
    messages,
    tools: [],
    toolsGeneration: 1,
    toolsHash: "tools-hash",
    system: "system",
    systemHash: "system-hash",
    policyGeneration: 0,
    resumeCount: 0,
    signal: new AbortController().signal,
    boundary,
  };
}

function testExecutor(): Executor {
  const recording = recordingLedger();
  return createExecutor({
    policy: allowAllPolicy,
    ledger: recording.ledger,
    observations: noopSink(),
    identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
    clock: () => 1,
    entropy: recording.entropy,
  });
}

function config(run: MockLlmFn, executor: Executor = testExecutor()) {
  return {
    events: noopSink(),
    executor,
    model: { provider: "anthropic", id: mockProviderModel.id },
    llm: createMockLlmConfig({
      getModels: async () => mockProviderData,
      fromModelsDevModel: () => mockProviderModel,
      run,
    }),
  };
}

const traceContext = { traceId: "trace-1", sessionId: "session-1", runId: "run-1" };

interface DurableRun {
  readonly actions: readonly LedgerAction.Node[];
  readonly inboxIds: readonly string[];
}

function actionPhase(action: LedgerAction.Node): string | undefined {
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.phase === "string" ? value.phase : undefined;
}

async function runDurably(run: MockLlmFn): Promise<DurableRun> {
  return Storage.withIsolation(async () => {
    Bus.reset();
    let nextId = 0;
    const runtime: SessionRuntime = {
      observations: Bus,
      clock: () => 1_000,
      entropy: () => `boundary-id-${++nextId}`,
      processId: "boundary-test",
      scheduleHeartbeat: () => () => undefined,
    };
    Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
    const policies = Storage.get().policies;
    if (policies === undefined) throw new Error("missing policy adapter");
    for (const row of SEEDED_POLICY_ROWS) policies.append({ ...row, generation: 1 });
    const chatRunner = createSessionChatRunner({
      prepare: (input) => ({
        config: config(run, createTurnDispatcher([], input, runtime).executor),
        traceContext,
      }),
    });
    const handle = session({ id: "boundary-session", role: "resident", runner: chatRunner }, runtime);

    try {
      const result = await handle.prompt("run the durable turn");
      if (result?.kind !== "result") throw new Error("durable chat did not return a result");
      return {
        actions: SessionHandleStore.tree(handle.id),
        inboxIds: SessionHandleStore.inboxRows(handle.id).map((row) => row.id),
      };
    } finally {
      await closeSessions(runtime);
      Storage.reset();
      Bus.reset();
    }
  });
}

describe("session chat runner", () => {
  it("returns interrupted before invoking the model", async () => {
    let calls = 0;
    const runner = createSessionChatRunner({
      prepare: () => ({
        config: config(async () => {
          calls += 1;
          return createStopOutcome();
        }),
        traceContext,
      }),
    });

    const result = await runner(input(async () => ({ messages: [], interrupted: true })));

    expect(result).toEqual({ kind: "interrupted" });
    expect(calls).toBe(0);
  });

  it("passes boundary messages into the model and returns its terminal result", async () => {
    const modelInputs: string[] = [];
    const boundaries: string[] = [];
    const runner = createSessionChatRunner({
      prepare: () => ({
        config: config(async ({ messages }) => {
          modelInputs.push(JSON.stringify(messages ?? []));
          return createStopOutcome();
        }),
        traceContext,
      }),
    });

    const result = await runner(input(async (boundary) => {
      boundaries.push(boundary);
      return boundary === "before_llm"
        ? { messages: [{ role: "user", text: "steered" }], interrupted: false }
        : { messages: [], interrupted: false };
    }));

    expect(boundaries).toEqual(["before_llm", "after_llm", "after_tools"]);
    expect(modelInputs[0]).toContain('"role":"user"');
    expect(modelInputs[0]).toContain('"text":"initial"');
    expect(modelInputs[0]).toContain('"text":"steered"');
    expect(modelInputs[0]?.indexOf('"text":"initial"')).toBeLessThan(
      modelInputs[0]?.indexOf('"text":"steered"') ?? -1,
    );
    expect(result).toMatchObject({ kind: "result", finishReason: "stop" });
  });

  it("starts another model turn when a post-model boundary supplies continuation", async () => {
    const modelInputs: string[] = [];
    let afterLlm = 0;
    const runner = createSessionChatRunner({
      prepare: () => ({
        config: config(async ({ messages }) => {
          modelInputs.push(JSON.stringify(messages ?? []));
          return createStopOutcome();
        }),
        traceContext,
      }),
    });

    const result = await runner(input(async (boundary) => {
      if (boundary === "after_llm" && afterLlm++ === 0) {
        return { messages: [{ role: "user", text: "continue" }], interrupted: false };
      }
      return { messages: [], interrupted: false };
    }));

    expect(modelInputs).toHaveLength(2);
    expect(modelInputs[1]).toContain('"role":"assistant"');
    expect(modelInputs[1]).toContain('"text":"continue"');
    expect(modelInputs[1]?.indexOf('"role":"assistant"')).toBeLessThan(
      modelInputs[1]?.indexOf('"text":"continue"') ?? -1,
    );
    expect(result.kind).toBe("result");
  });

  it("returns interrupted at either post-model boundary", async () => {
    for (const interruptedAt of ["after_llm", "after_tools"] as const) {
      const runner = createSessionChatRunner({
        prepare: () => ({ config: config(async () => createStopOutcome()), traceContext }),
      });
      const result = await runner(input(async (boundary) => ({
        messages: [],
        interrupted: boundary === interruptedAt,
      })));
      expect(result.kind).toBe("interrupted");
    }
  });

  it("records real prompt and turn ownership with sibling llm pairs for normal calls", async () => {
    let calls = 0;

    const { actions, inboxIds } = await runDurably(async () => {
      calls += 1;
      return calls === 1 ? { type: "continue" } : createStopOutcome();
    });

    const llmIntents = actions.filter(
      (action) => action.kind === "llm" && actionPhase(action) === "intent",
    );
    const llmResults = actions.filter(
      (action) => action.kind === "llm" && actionPhase(action) === "result",
    );
    expect(calls).toBe(2);
    expect(llmIntents).toHaveLength(2);
    expect(llmResults).toHaveLength(2);

    const turnIntents = actions.filter(
      (action) => action.kind === "turn" && actionPhase(action) === "intent",
    );
    const turnTerminals = actions.filter(
      (action) => action.kind === "turn" && actionPhase(action) === "terminal",
    );
    expect(turnIntents).toHaveLength(1);
    expect(turnTerminals).toHaveLength(1);
    const turnIntent = turnIntents[0];
    if (turnIntent === undefined) throw new Error("missing durable turn intent");
    expect(llmIntents.map((action) => action.parentId)).toEqual([
      turnIntent.id,
      turnIntent.id,
    ]);
    expect(llmResults.map((action) => action.parentId)).toEqual(
      llmIntents.map((action) => action.id),
    );

    const prompts = actions.filter((action) => action.kind === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.id).toBe(inboxIds[0]);
  });

  it("records retry attempts beneath one logical llm action", async () => {
    const sleep = spyOn(LlmRetry, "sleep").mockResolvedValue(undefined);
    let calls = 0;

    try {
      const { actions } = await runDurably(async () => {
        calls += 1;
        return calls === 1
          ? { type: "error", error: new Error("transient provider outage") }
          : createStopOutcome();
      });

      const llmIntents = actions.filter(
        (action) => action.kind === "llm" && actionPhase(action) === "intent",
      );
      const attempts = actions.filter(
        (action) => action.kind === "attempt" && actionPhase(action) === "intent",
      );
      const attemptResults = actions.filter(
        (action) => action.kind === "attempt" && actionPhase(action) === "result",
      );
      expect(calls).toBe(2);
      expect(llmIntents).toHaveLength(1);
      expect(attempts).toHaveLength(2);
      expect(attemptResults.map((action) => action.parentId)).toEqual(
        attempts.map((action) => action.id),
      );
      const llmIntent = llmIntents[0];
      if (llmIntent === undefined) throw new Error("missing logical llm intent");
      expect(attempts.map((action) => action.parentId)).toEqual([
        llmIntent.id,
        llmIntent.id,
      ]);
    } finally {
      sleep.mockRestore();
    }
  });

  it("does not invoke the model when a durable chat composition loses its executor", async () => {
    let calls = 0;
    const preparedConfig = config(async () => {
      calls += 1;
      return createStopOutcome();
    });
    Reflect.deleteProperty(preparedConfig, "executor");
    const runner = createSessionChatRunner({
      prepare: () => ({ config: preparedConfig, traceContext }),
    });

    await expect(
      runner(input(async () => ({ messages: [], interrupted: false }))),
    ).rejects.toThrow("executor");
    expect(calls).toBe(0);
  });

  it("turns reported failures into error results and rethrows unreported failures", async () => {
    const cause = new Error("prepare failed");
    const reported = createSessionChatRunner({
      prepare: () => {
        throw cause;
      },
      reportError: (error) => error === cause ? "reported" : undefined,
    });
    const unreported = createSessionChatRunner({
      prepare: () => {
        throw cause;
      },
    });
    const ready = input(async () => ({ messages: [], interrupted: false }));

    expect(await reported(ready)).toEqual({
      kind: "error",
      text: "reported",
      cause,
      reported: true,
    });
    expect(unreported(ready)).rejects.toBe(cause);
  });
});
