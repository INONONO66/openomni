import type { TraceContext } from "@openomni/protocol";
import { ChatAgent } from "./core/chat-agent";
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
      if (input.execution === undefined)
        throw new Error("durable chat runner requires an execution lifecycle");
      const execute = () =>
        ChatAgent.create({
          ...prepared.config,
          execution: input.execution,
          signal: input.signal,
          boundary: input.boundary,
        }).run({ messages, traceContext: prepared.traceContext });
      const result = await (prepared.around?.(execute) ?? execute());
      return {
        kind: "result",
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (cause.name === "AbortError") return { kind: "interrupted" };
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
