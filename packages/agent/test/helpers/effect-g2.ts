import { sessionTree } from "./session-tree";
import { runChatAttempts } from "./chat-attempts";
import { seededTestAgent } from "./seeded-test-agent";
import { recordingLedger } from "./recording-ledger";
import { commitReceivedMessage } from "./ingress";
import { isolatedLedger } from "./isolated";
import { testExecutor } from "./executor";
import { catalogLayer, dispatcherToolPorts } from "./service-layers";
import {
  type ChatFixture as ChatAgentConfig,
  fixtureConfigHead,
  fixtureTraceContext,
  prepareChatFixture,
} from "./chat-services";
import type { SessionFixture as SessionRuntime } from "./session-services";
import { createSessionChatRunner } from "../../src/session-chat-runner";
import { createTurnDispatcher } from "../../src/tool-dispatcher";
import type { AnyToolDefinition } from "@openomni/protocol";
import type { Run, RunInput } from "@openomni/llm";
import type {} from "../../src/session-contract";
import { PlainValueSchema } from "@openomni/protocol";
import { createCompactionPlan } from "../../src/compaction/durable";
import { createAssistantMessage } from "../../src/core/message-factory";
import { foldSessionHistory } from "../../src/session-lifecycle/history";
import type { SessionRunnerInput, SessionRunnerResult } from "../../src/session-contract";
import { Cause, Effect, Exit, Fiber } from "effect";
import type { LedgerAction, SessionTransition } from "@openomni/protocol";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { ChatAgentInput } from "../../src/core/types";
import type { Sink } from "@openomni/llm";
import type { ExecutorOptions, DurableExecutor } from "../../src/executor-contract";
import type { SessionHandle } from "../../src/session-handle";
import { AgentFailure, CommitFailed } from "../../src/errors";
import { allowAllPolicy } from "./compiled-policy";
import { runInput } from "./run-input";

export const nullRetryAlarm: NonNullable<ExecutorOptions["retryAlarm"]> = {
  arm: () => Effect.void,
  wait: () => Effect.void,
  settle: () => Effect.void,
};

export { recordingLedger };

export function recordingExecutor(
  options: { readonly onCommit?: (action: LedgerAction.Append) => void | Promise<void> } = {},
) {
  const record = recordingLedger();
  const executor = testExecutor({
    policy: allowAllPolicy,
    retryAlarm: nullRetryAlarm,
    ledger: {
      commit: (action: LedgerAction.Append) =>
        record.ledger.commit(action).pipe(
          Effect.tap(() =>
            options.onCommit === undefined
              ? Effect.void
              : Effect.promise(async () => {
                  await options.onCommit?.(action);
                }),
          ),
        ),
    },
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: () => 1,
    entropy: record.entropy,
  });
  return { committed: record.committed, executor };
}

export function turnExecutor(policy: CompiledPolicySnapshot) {
  const record = recordingLedger();
  return {
    ...record,
    executor: testExecutor({
      policy,
      ledger: record.ledger,
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
      clock: () => 1,
      entropy: record.entropy,
      retryAlarm: nullRetryAlarm,
    }),
  };
}

export const createTestAgent = seededTestAgent(nullRetryAlarm);
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
  return Effect.suspend(() =>
    commitReceivedMessage(isolatedLedger().kernel, {
      id: message.messageId,
      sessionId: message.destinationSessionId,
      kind: "prompt",
      content: message.content,
      origin: { encodingVersion: 1, value: message },
      createdAt,
      parentActionId: null,
    }),
  ).pipe(
    Effect.mapError((error: import("@openomni/ledger").LedgerError) => new CommitFailed({ error })),
  );
}
export function suspendedRequest(handle: SessionHandle, suspended: Promise<void>) {
  return Effect.gen(function* () {
    const running = yield* Effect.forkScoped(handle.prompt("perform original call"));
    yield* Effect.promise(() => suspended).pipe(Effect.timeout("5 seconds"));
    const kernel = isolatedLedger().kernel;
    const request = kernel.requestRows(handle.id)[0];
    if (request === undefined) throw new Error("missing request");
    return {
      running,
      settled: Fiber.await(running),
      request,
      fence: kernel.row(handle.id).leaseFence,
    };
  });
}
export { runChatAttempts };
export function answerThenCompact(executor: DurableExecutor, input: SessionRunnerInput) {
  return Effect.gen(function* () {
    const answer = createAssistantMessage("answer", "", input.sessionId);
    yield* executor.run(
      { kind: "message", op: "assistant", intent: { messageId: answer.info.id }, effect: {} },
      () => Effect.sync(() => PlainValueSchema.parse(answer)),
    );
    const prior = foldSessionHistory(input.sessionId, sessionTree(input.kernel, input.sessionId));
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
    prepare: (input: SessionRunnerInput) =>
      Effect.gen(function* () {
        const dispatcher = yield* createTurnDispatcher(input, runtime()).pipe(
          Effect.provide(catalogLayer(definitions)),
        );
        return prepareChatFixture({
          traceContext: fixtureTraceContext(input),
          config: {
            ...fixtureConfigHead(dispatcher.executor),
            ...dispatcherToolPorts(dispatcher, input),
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
  return new AgentFailure({ operation, cause: String(cause) });
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
