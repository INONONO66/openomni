import type { TraceContext } from "@openomni/protocol";
import { runAgent } from "./core/execution/run";
import { activeExecutor } from "./executor-context";
import type { AgentResult, ChatAgentConfig } from "./core/types";
import type { Executor } from "./executor";
import type { SessionRunner, SessionRunnerInput, SessionRunnerResult } from "./session-handle";

interface SessionChatRun {
  readonly config: ChatAgentConfig & { readonly executor: Executor };
  readonly traceContext: TraceContext.Type;
  readonly around?: (operation: () => Promise<AgentResult>) => Promise<AgentResult>;
}

export interface SessionChatRunnerOptions {
  readonly prepare: (input: SessionRunnerInput) => SessionChatRun;
  readonly reportError?: (error: Error, input: SessionRunnerInput) => string | undefined;
}

export function createSessionChatRunner(options: SessionChatRunnerOptions): SessionRunner {
  return async (input) => {
    const messages = input.messages.map((message) => ({
      role: message.role,
      content: message.text,
      id: message.id,
    }));
    try {
      const prepared = options.prepare(input);
      if (prepared.config.executor === undefined)
        throw new Error("durable chat runner requires an executor");
      const executor = prepared.config.executor;
      if (executor.runAttempts === undefined || executor.judgeStop === undefined)
        throw new Error("durable chat runner requires session attempt and stop authority");
      const execution = { runAttempts: executor.runAttempts, judgeStop: executor.judgeStop };
      const execute = () =>
        activeExecutor.run(prepared.config.executor, () =>
          runAgent(
            { messages, history: input.history, traceContext: prepared.traceContext },
            {
              ...prepared.config,
              execution,
              signal: input.signal,
              boundary: input.boundary,
              stopEvidence: input.stopEvidence,
            },
          ),
        );
      const result = await (prepared.around?.(execute) ?? execute());
      if (result.waiting !== undefined)
        return { kind: "waiting", text: result.text, ...result.waiting };
      return {
        kind: "result",
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (
        cause.name === "AbortError" ||
        (cause instanceof Error &&
          "data" in cause &&
          typeof cause.data === "object" &&
          cause.data !== null &&
          "aborted" in cause.data &&
          cause.data.aborted === true)
      )
        return { kind: "interrupted" };
      const reported = options.reportError?.(cause, input);
      if (reported === undefined) throw cause;
      const result: SessionRunnerResult = {
        kind: "error",
        text: reported,
        cause,
        reported: true,
      };
      return result;
    }
  };
}
