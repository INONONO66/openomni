import type { RunInput, Run, Sink } from "@openomni/llm";
import { createAssistantMessage } from "../../src/core/message-factory";

/** A stub concerned only with call arguments still supplies a valid final provider message. */
export function modelFixture(run: (input: RunInput, sink: Sink) => Promise<Run.Outcome>) {
  return async (input: RunInput, sink: Sink): Promise<Run.Outcome> => {
    let emitted = false;
    const result = await run(input, {
      ...sink,
      onMessage(message) {
        emitted = true;
        sink.onMessage(message);
      },
    });
    if (result.type === "stop" && !emitted)
      sink.onMessage(createAssistantMessage("fixture completion", "", input.trace.sessionId));
    return result;
  };
}
