import type { TraceContext } from "@openomni/protocol";
import { createSessionChatRunner } from "../../src/session-chat-runner";
import { completeModel, type MockLlmFn } from "./mock-llm";

type Prepared = ReturnType<Parameters<typeof createSessionChatRunner>[0]["prepare"]>;

export function recordingChatRunner(config: (run: MockLlmFn) => Prepared["config"], traceContext: TraceContext.Type) {
  const modelInputs: string[] = [];
  const runner = createSessionChatRunner({
    prepare: () => ({
      config: config(async (input, sink) => {
        modelInputs.push(JSON.stringify(input.messages));
        return completeModel(input, sink);
      }),
      traceContext,
    }),
  });
  return { runner, modelInputs };
}
