import { Effect } from "effect";
import type { TraceContext } from "@openomni/protocol";
import { runAgent } from "./core/execution/run";
import type { AgentResult, ChatAgentConfig } from "./core/types";
import type { Executor } from "./executor";
import type { SessionRunner, SessionRunnerInput, SessionRunnerResult } from "./session-handle";
import { foldSessionHistory } from "./session-lifecycle/history";
import { pinnedModelSelection } from "./model-selection";
import type { ExecutionError } from "./errors";
import type { RunnerServices } from "./services";

interface SessionChatRun {
  readonly config: ChatAgentConfig & { readonly executor: Executor };
  readonly traceContext: TraceContext.Type;
  readonly around?: (operation: Effect.Effect<AgentResult, ExecutionError, RunnerServices>) => Effect.Effect<AgentResult, ExecutionError, RunnerServices>;
}

interface SessionChatRunnerOptions {
  readonly prepare: (input: SessionRunnerInput) => Effect.Effect<SessionChatRun, ExecutionError, RunnerServices>;
  readonly reportError?: (error: Error, input: SessionRunnerInput) => string | undefined;
}

export function createSessionChatRunner(options: SessionChatRunnerOptions): SessionRunner {
  return (input) => Effect.gen(function* () {
    const messages = input.messages.map((message) => ({ role: message.role, content: message.text, id: message.id }));
    const prepared = yield* options.prepare(input);
    const executor = prepared.config.executor;
    if (executor.recover === undefined || executor.runAttempts === undefined || executor.judgeStop === undefined)
      return yield* Effect.die(new Error("durable chat runner requires session authority"));
    yield* executor.recover();
    const actions = input.ledger.actions?.();
    const operation = runAgent({
      messages,
      history: actions === undefined ? input.history : foldSessionHistory(input.sessionId, actions),
      traceContext: prepared.traceContext,
    }, {
      ...prepared.config,
      ...(actions === undefined ? {} : { pinnedModel: pinnedModelSelection(actions, input.turnId) }),
      execution: { runAttempts: executor.runAttempts, judgeStop: executor.judgeStop },
      signal: input.signal,
      boundary: input.boundary,
      stopEvidence: input.stopEvidence,
    });
    const result = yield* (prepared.around?.(operation) ?? operation);
    if (result.waiting !== undefined) return { kind: "waiting", text: result.text, ...result.waiting } satisfies SessionRunnerResult;
    return { kind: "result", text: result.text, finishReason: result.finishReason, usage: result.usage } satisfies SessionRunnerResult;
  }).pipe(Effect.catchAll((error): Effect.Effect<SessionRunnerResult, ExecutionError> => {
    if (error._tag === "Interrupted" || (error._tag === "LlmRunFailure" && error.aborted))
      return Effect.succeed({ kind: "interrupted" } satisfies SessionRunnerResult);
    const reported = options.reportError?.(error, input);
    return reported === undefined ? Effect.fail(error) : Effect.succeed({
      kind: "error", text: reported, cause: error, reported: true,
    } satisfies SessionRunnerResult);
  }));
}
