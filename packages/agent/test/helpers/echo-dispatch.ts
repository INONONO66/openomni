import type { Effect } from "effect";
import type { createDispatcher } from "../../src/tool-dispatcher";

export function dispatchEcho(dispatcher: Effect.Effect.Success<ReturnType<typeof createDispatcher>>, text: string) {
  return dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text } },
    { sessionId: "session-1", turnId: "turn-1" },
  );
}
