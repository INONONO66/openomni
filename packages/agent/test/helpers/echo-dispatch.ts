import type { Effect } from "effect";
import type { createDispatcher } from "../../src/kernel/tool";

export function dispatchEcho(dispatcher: Effect.Success<ReturnType<typeof createDispatcher>>, text: string) {
  return dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text } },
    { sessionId: "session-1", turnId: "turn-1" },
  );
}
