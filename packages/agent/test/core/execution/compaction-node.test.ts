import { expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { createCompactionPlan, restoreCompactionProjection } from "../../../src/compaction/durable";
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
  expect(result).toHaveProperty("record.firstKeptEntryId", "original-2");
});

it("restores exact originals when a replacement has no shared suffix", () => {
  // Given: the review countercase, with a synthesized replacement only.
  const prior = [assistant("original-1"), assistant("original-2")];
  const replacement: Message.WithParts[] = [
    {
      info: {
        id: "new-anchor",
        sessionID: "compaction-937",
        role: "user",
        time: { created: 2 },
        agent: "resident",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [
        {
          id: "anchor-text",
          sessionID: "compaction-937",
          messageID: "new-anchor",
          type: "text",
          text: "summary",
          metadata: { compactionAnchor: true, anchorBody: "summary" },
        },
      ],
    },
  ];
  // When: the durable projection plan is constructed from that replacement.
  const plan = createCompactionPlan(prior, replacement, 450);
  // Then: its kept boundary is original and restoration removes the synthesis.
  expect(plan.record.firstKeptEntryId).toBe("original-2");
  expect(restoreCompactionProjection(plan.projection, plan.record)).toEqual(prior);
});

it("snapshots removed evidence independently of mutable source messages", () => {
  // Given: an ordinary shared original suffix.
  const prior = [assistant("first"), assistant("last")];
  const original = structuredClone(prior);
  const tail = prior[1];
  if (tail === undefined) throw new Error("missing fixture tail");
  // When: a plan is taken before the source is mutated.
  const plan = createCompactionPlan(prior, [tail], 450);
  prior[0]?.parts.splice(0);
  // Then: the revert payload still contains exact source-time evidence.
  expect(restoreCompactionProjection(plan.projection, plan.record)).toEqual(original);
});

it("retains concurrent entries after restoring a full-range elision", () => {
  // Given: both originals were replaced with elided same-ID entries.
  const prior = [assistant("first"), assistant("last")];
  const replacement = prior.map((entry) => ({ ...entry, parts: [] }));
  const concurrent = assistant("concurrent");
  // When: a full-range plan is projected, then another entry arrives.
  const plan = createCompactionPlan(prior, replacement, 450);
  const restored = restoreCompactionProjection([...plan.projection, concurrent], plan.record);
  // Then: there is one original copy per ID, followed by the concurrent entry.
  expect(plan.record.firstKeptEntryId).toBe("last");
  expect(restored).toEqual([...prior, concurrent]);
});
