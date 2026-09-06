import { expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Compaction } from "../../../src/compaction/compact";

function assistant(id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "compaction-937",
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "model",
      providerID: "provider",
      agent: "resident",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}-tool`,
        sessionID: "compaction-937",
        messageID: id,
        type: "tool",
        callID: `${id}-call`,
        tool: "read",
        state: {
          status: "completed",
          input: { path: id },
          output: "evidence ".repeat(100),
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  };
}

it("retains an original atomic entry when the configured protected tail is zero", async () => {
  // Given: a full-rewrite candidate with real completed call/result pairs.
  const prior = [assistant("original-1"), assistant("original-2")];
  // When: the real compaction strategy summarizes the window.
  const result = await Compaction.compact(
    prior,
    {
      contextWindowTokens: 1000,
      protectRecentMessages: 0,
      onSummarize: async () => "summary",
    },
    { traceId: "trace-937", sessionId: "compaction-937" },
    { publish: () => undefined },
    { trigger: "yield" },
  );
  // Then: the suffix boundary is original content, not a synthesized anchor.
  expect(result.compacted).toBe(true);
  expect(result.messages.at(-1)).toEqual(prior.at(-1));
});
