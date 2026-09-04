import type { TraceContext } from "@openomni/protocol";
import { ChatAgent } from "./core/chat-agent";
import type { AgentResult, ChatAgentConfig } from "./core/types";
import type { SessionRunner, SessionRunnerInput, SessionRunnerResult } from "./session-handle";

interface SessionChatRun {
  readonly config: ChatAgentConfig;
  readonly traceContext: TraceContext.Type;
  readonly around?: (operation: () => Promise<AgentResult>) => Promise<AgentResult>;
}

export interface SessionChatRunnerOptions {
  readonly prepare: (input: SessionRunnerInput) => SessionChatRun;
  readonly reportError?: (error: Error, input: SessionRunnerInput) => string | undefined;
}

const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export function createSessionChatRunner(options: SessionChatRunnerOptions): SessionRunner {
  return async (input) => {
    const messages = input.messages.map((message) => ({
      role: message.role,
      content: message.text,
    }));
    let usage = { ...emptyUsage };

    try {
      for (;;) {
        const beforeLlm = await input.boundary("before_llm");
        if (beforeLlm.interrupted) return { kind: "interrupted" };
        for (const message of beforeLlm.messages) {
          messages.push({ role: message.role, content: message.text });
        }

        const prepared = options.prepare(input);
        const execute = () =>
          ChatAgent.create({ ...prepared.config, signal: input.signal }).run({
            messages,
            traceContext: prepared.traceContext,
          });
        const result = await (prepared.around?.(execute) ?? execute());
        usage = addUsage(usage, result.usage);

        const afterLlm = await input.boundary("after_llm");
        if (afterLlm.interrupted) return { kind: "interrupted" };
        const afterTools = await input.boundary("after_tools");
        if (afterTools.interrupted) return { kind: "interrupted" };
        const continuation = [...afterLlm.messages, ...afterTools.messages];
        if (continuation.length === 0) {
          return {
            kind: "result",
            text: result.text,
            finishReason: result.finishReason,
            usage,
          };
        }

        messages.push({ role: "assistant", content: result.text });
        for (const message of continuation) {
          messages.push({ role: message.role, content: message.text });
        }
      }
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
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

function addUsage(
  left: NonNullable<Extract<SessionRunnerResult, { readonly kind: "result" }>["usage"]>,
  right: AgentResult["usage"],
): NonNullable<Extract<SessionRunnerResult, { readonly kind: "result" }>["usage"]> {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0),
  };
}
