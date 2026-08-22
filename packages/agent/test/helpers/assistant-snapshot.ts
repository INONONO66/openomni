import type { Message } from "@openomni/protocol";

/**
 * The llm fold's assistant boundary snapshot, minimally shaped for loop
 * tests: one text part plus one step-finish part. `stepReason` decides how
 * `turnYield` classifies the turn end ("stop" = the model's own stop,
 * "tool-calls" = the loop stopped it mid tool-loop).
 */
export function assistantSnapshot(
  id: string,
  text: string,
  stepReason: "tool-calls" | "stop" = "stop",
): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "test",
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "test",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { id: `${id}-t`, sessionID: "test", messageID: id, type: "text", text },
      {
        id: `${id}-s`,
        sessionID: "test",
        messageID: id,
        type: "step-finish",
        reason: stepReason,
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  };
}
