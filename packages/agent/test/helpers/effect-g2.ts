import { catalogLayer } from "./service-layers";
import { type ChatFixture as ChatAgentConfig, type ChatFixture, chatServices, prepareChatFixture } from "./chat-services";
import type { SessionFixture as SessionRuntime } from "./session-services";
import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import type { ResolvedExecutorOptions } from "../../src/executor-contract";
import { executorLayer } from "./service-layers";
import { createSessionChatRunner } from "../../src/session-chat-runner";
import { createTurnDispatcher } from "../../src/tool-dispatcher";
import type { AnyToolDefinition, Tool } from "@openomni/protocol";
import type { Run, RunInput } from "@openomni/llm";
import type {} from "../../src/session-contract";
import { PlainValueSchema } from "@openomni/protocol";
import { createCompactionPlan } from "../../src/compaction/durable";
import { createAssistantMessage } from "../../src/core/message-factory";
import { foldSessionHistory } from "../../src/session-lifecycle/history";
import type { SessionRunnerInput, SessionRunnerResult } from "../../src/session-contract";
import { Cause, Effect, Exit, Fiber } from "effect";
import { SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction, PlainObject, PlainValue, SessionTransition } from "@openomni/protocol";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { ChatAgentInput } from "../../src/core/types";
import type { Sink } from "@openomni/llm";
import { createExecutor } from "../../src/executor";
import type { ExecutorOptions, DurableExecutor, LlmAttempts } from "../../src/executor-contract";
import type { SessionHandle } from "../../src/session-handle";
import { runAgent } from "../../src/core/execution/run";
import { ForeignFailure, CommitFailed, type ExecutionError } from "../../src/errors";
import { allowAllPolicy, fixtureHashes } from "./compiled-policy";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import { runInput } from "./run-input";

export const nullRetryAlarm: NonNullable<ExecutorOptions["retryAlarm"]> = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};

export function recordingLedger(committed: LedgerAction.Append[] = []) {
  let ordinal = 0;
  return {
    committed,
    entropy: () => `action-${ordinal + 1}`,
    ledger: {
      commit: (action: LedgerAction.Append) =>
        Effect.sync(() => {
          committed.push(action);
          ordinal += 1;
          return {
            action: { ...action, ordinal, ...fixtureHashes(ordinal) },
            revision: ordinal,
          };
        }),
    },
  };
}

export function recordingExecutor(
  options: { readonly onCommit?: (action: LedgerAction.Append) => void | Promise<void> } = {},
) {
  const record = recordingLedger();
  const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
    policy: allowAllPolicy,
    retryAlarm: nullRetryAlarm,
    ledger: {
      commit: (action: LedgerAction.Append) =>
        record.ledger.commit(action).pipe(
          Effect.tap(() => options.onCommit === undefined ? Effect.void :
            Effect.promise(async () => {
              await options.onCommit?.(action);
            }),
          ),
        ),
    },
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: () => 1,
    entropy: record.entropy,
  }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
  return { committed: record.committed, executor };
}

export function turnExecutor(policy: CompiledPolicySnapshot) {
  const record = recordingLedger();
  return {
    ...record,
    executor: Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
      policy,
      ledger: record.ledger,
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
      clock: () => 1,
      entropy: record.entropy,
      retryAlarm: nullRetryAlarm,
    }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); })),
  };
}

export function createTestAgent(config: ChatAgentConfig) {
  return {
    run(input: ChatAgentInput, sink?: Sink) {
      const record = recordingLedger();
      const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
        policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
          generation: 1,
          rows: SEEDED_POLICY_ROWS.map(
            (row: Omit<import("@openomni/protocol").PolicyRow.Row, "generation">) => ({
              ...row,
              generation: 1,
            }),
          ),
        }),
        ledger: record.ledger,
        observations: config.events,
        signal: config.signal,
        clock: () => Date.now(),
        entropy: record.entropy,
        retryAlarm: nullRetryAlarm,
        identity: {
          sessionId: input.traceContext?.sessionId ?? "session",
          role: "resident",
          parentActionId: null,
        },
      }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
      return Effect.gen(function* () { const fixture: ChatFixture = { executor, execution: executor, ...config }; const { events: _events, llm: _llm, ...acquiredConfig } = fixture; return yield* runAgent(input, acquiredConfig, sink).pipe(Effect.provide(chatServices(fixture))); });
    },
  };
}
export function runTestAgent(input: ChatAgentInput, config: ChatAgentConfig, sink?: Sink) {
  return createTestAgent(config).run(input, sink);
}
export function runUserMessage(config: ChatAgentConfig, content: string) {
  return runTestAgent(runInput([{ role: "user", content }]), config);
}
export function runTestOperation(
  executor: DurableExecutor,
  kind: LedgerAction.Kind,
  body: () => Effect.Effect<{ ok: boolean }>,
) {
  return executor.run(
    { kind, op: "test", intent: { requested: true }, effect: { completed: true } },
    body,
  );
}
export function receiveOutbound(message: SessionTransition.OutboundMessage, createdAt: number) {
  return SessionHandleStore.commitReceivedMessage({
    id: message.messageId,
    sessionId: message.destinationSessionId,
    kind: "prompt",
    content: message.content,
    origin: { encodingVersion: 1, value: message },
    createdAt,
    parentActionId: null,
  }).pipe(
    Effect.mapError((error: import("@openomni/ledger").LedgerError) => new CommitFailed({ error })),
  );
}
export function suspendedRequest(handle: SessionHandle, suspended: Promise<void>) {
  return Effect.gen(function* () {
    const running = yield* Effect.forkScoped(handle.prompt("perform original call"));
    yield* Effect.promise(() => suspended).pipe(Effect.timeout("5 seconds"));
    const request = SessionHandleStore.requestRows(handle.id)[0];
    if (request === undefined) throw new Error("missing request");
    return {
      running,
      settled: Fiber.await(running),
      request,
      fence: SessionHandleStore.row(handle.id).leaseFence,
    };
  });
}
export function runChatAttempts<T extends PlainValue>(
  executor: Pick<DurableExecutor, "run" | "runAttempts">,
  body: (attempt: number) => Effect.Effect<T, ExecutionError>,
  evidence?: LlmAttempts<T>["evidence"],
  intent?: PlainObject,
) {
  return executor.run(
    { kind: "llm", op: "chat", intent: {}, effect: {} },
    (parent: LedgerAction.Receipt) =>
      executor.runAttempts(parent, {
        prepare: (attempt: number) =>
          Effect.succeed({
            request: { op: "chat", intent: intent ?? { attempt }, effect: {} },
            admit: () => Effect.void,
            body: () => body(attempt),
          }),
        ...(evidence === undefined ? {} : { evidence }),
      }),
  );
}
export function answerThenCompact(executor: DurableExecutor, input: SessionRunnerInput) {
  return Effect.gen(function* () {
    const answer = createAssistantMessage("answer", "", input.sessionId);
    yield* executor.run(
      { kind: "message", op: "assistant", intent: { messageId: answer.info.id }, effect: {} },
      () => Effect.sync(() => PlainValueSchema.parse(answer)),
    );
    const prior = foldSessionHistory(input.sessionId, input.ledger.actions?.() ?? []);
    const plan = createCompactionPlan(prior, [answer], 100);
    yield* executor.run(
      {
        kind: "compaction",
        op: "compact",
        intent: { trigger: "threshold" },
        effect: {},
        revertData: () => PlainValueSchema.parse(plan.record.revert),
      },
      () =>
        Effect.sync(() => PlainValueSchema.parse({ ...plan.record, projection: plan.projection })),
    );
    return { kind: "result", text: "answer", finishReason: "stop" } satisfies SessionRunnerResult;
  });
}

export function dispatchingRunner(
  definitions: readonly AnyToolDefinition[],
  runtime: () => SessionRuntime,
  model: (request: RunInput, sink: Sink, input: SessionRunnerInput) => Promise<Run.Outcome>,
) {
  return createSessionChatRunner({
    prepare: (input: SessionRunnerInput) => Effect.gen(function* () {
      const dispatcher = (yield* createTurnDispatcher(input, runtime()).pipe(Effect.provide(catalogLayer(definitions))));
      return prepareChatFixture({
        traceContext: { traceId: "trace", sessionId: input.sessionId, runId: input.resultId },
        config: {
          events: { publish: () => undefined },
          executor: dispatcher.executor,
          model: { provider: "test", id: "test" },
          tools: [...dispatcher.specs],
          toolWave: (calls: readonly Tool.Call[], signal?: AbortSignal) =>
            dispatcher.executeWave(calls, {
              sessionId: input.sessionId,
              turnId: input.turnId,
              signal,
            }),
          toolExecutor: (call: Tool.Call) =>
            dispatcher.execute(call, { sessionId: input.sessionId, turnId: input.turnId }),
          llm: {
            resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
            run: (request: RunInput, sink: Sink) =>
              Effect.promise(() => model(request, sink, input)),
          },
        },
      });
    }),
  });
}

export function foreign(operation: string, cause: unknown) {
  return new ForeignFailure({ operation, cause: String(cause) });
}

/** Inspect typed failures and defects without Promise rejection wrappers. */
export function failure<A, E, R>(program: Effect.Effect<A, E, R>) {
  return program.pipe(
    Effect.exit,
    Effect.map((exit: Exit.Exit<A, E>): unknown => {
      if (Exit.isSuccess(exit)) throw new Error("expected a failed Effect");
      return Cause.squash(exit.cause);
    }),
  );
}
