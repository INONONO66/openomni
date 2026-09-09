import type { createDispatcher } from "../../src/tool-dispatcher";

export function dispatchEcho(dispatcher: ReturnType<typeof createDispatcher>, text: string) {
  return dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text } },
    { sessionId: "session-1", turnId: "turn-1" },
  );
}
