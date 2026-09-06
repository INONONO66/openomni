import { expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { runAgent } from "../../../src/core/execution/run";
import { compiledPolicy, recordingExecutor } from "../../helpers/compiled-policy";
import { runInput } from "../../helpers/run-input";
import { RunEvents } from "../../../src/core/execution/events";
import { executeCompaction } from "../../../src/compaction/execute-cut";
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

it("refuses compaction restoration when the original kept boundary is missing", () => {
  const tail = assistant("last");
  const plan = createCompactionPlan([assistant("first"), tail], [tail], 450);
  // A concurrent replacement removed the kept boundary; restoring would splice
  // unrelated history onto the discarded entries rather than undo this cut.
  expect(() => restoreCompactionProjection([assistant("unrelated")], plan.record)).toThrow(Error);
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

it("commits a reversible compaction result before completion observations and the next model call", async () => {
  // Given: a real executor and an overflow at the provider I/O seam.
  const recording = recordingExecutor();
  let calls = 0;
  let durableAtObservation = false;
  let durableAtNextCall = false;
  const committedRecord = () =>
    recording.committed.some((action) => action.kind === "compaction" && "revert" in action);
  // When: the production run loop recovers through its compaction path.
  await runAgent(
    runInput([
      { role: "user", content: "goal" },
      { role: "assistant", content: "prior evidence ".repeat(200) },
      { role: "user", content: "continue" },
    ]),
    {
      events: {
        publish(event) {
          if (event.name === RunEvents.CompactionCompleted.name)
            durableAtObservation = committedRecord();
        },
      },
      executor: recording.executor,
      model: { provider: "provider", id: "model" },
      compaction: {
        contextWindowTokens: 1000,
        protectRecentMessages: 1,
        speculate: false,
        onSummarize: async () => "checkpoint",
      },
      llm: {
        resolveModel: async () => ({
          id: "model",
          name: "model",
          providerID: "provider",
          limit: { context: 1000, output: 100 },
        }),
        run: async () => {
          calls += 1;
          if (calls === 1) return { type: "error", error: new Error("prompt is too long") };
          durableAtNextCall = committedRecord();
          return { type: "stop" };
        },
      },
    },
  );
  // Then: the durable reversible action precedes both consumers.
  expect(durableAtObservation).toBe(true);
  expect(durableAtNextCall).toBe(true);
  expect(
    recording.committed.filter((action) => action.kind === "compaction" && "revert" in action),
  ).toHaveLength(1);
});

function executionInput(
  executor: Parameters<typeof executeCompaction>[0]["executor"],
  observed: string[],
): Parameters<typeof executeCompaction>[0] {
  return {
    history: [assistant("first"), assistant("last")],
    executor,
    options: {
      contextWindowTokens: 1000,
      protectRecentMessages: 1,
      onSummarize: async () => "summary",
    },
    identity: { traceId: "trace", sessionId: "session-1" },
    dispatch: { trigger: "yield" },
    events: {
      publish(event) {
        observed.push(event.name);
      },
    },
  };
}

it("holds completion observation until the reversible commit resolves", async () => {
  // Given: the real executor's durable result commit is explicitly gated.
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const recording = recordingExecutor({
    async onCommit(action) {
      if (action.kind === "compaction" && "revert" in action) {
        reached.resolve();
        await release.promise;
      }
    },
  });
  const observed: string[] = [];
  // When: compaction reaches that exact unresolved commit.
  const pending = executeCompaction(executionInput(recording.executor, observed));
  await reached.promise;
  expect(observed).toEqual([RunEvents.CompactionStarted.name]);
  release.resolve();
  await pending;
  // Then: completion follows persistence, never precedes it.
  expect(observed).toEqual([RunEvents.CompactionStarted.name, RunEvents.CompactionCompleted.name]);
});

it("does not report completion or mutate history when the reversible commit fails", async () => {
  // Given: a fenced commit failure, not a mock compaction implementation.
  const failure = new Error("fence rejected");
  const recording = recordingExecutor({
    async onCommit(action) {
      if (action.kind === "compaction" && "revert" in action) throw failure;
    },
  });
  const observed: string[] = [];
  const input = executionInput(recording.executor, observed);
  const original = structuredClone(input.history);
  // When: the real strategy succeeds but its durable result cannot commit.
  await expect(executeCompaction(input)).rejects.toBe(failure);
  // Then: the active history and success observation remain untouched.
  expect(input.history).toEqual(original);
  expect(observed).toEqual([RunEvents.CompactionStarted.name]);
});

it("refuses compaction before the summarizer when compiled pre policy denies it", async () => {
  // Given: a real compiled compaction pre denial.
  const recording = recordingExecutor({
    policy: compiledPolicy([
      {
        name: "deny-compaction",
        kind: "turn",
        phase: "post",
        generation: 1,
        priority: 2000,
        match: { encodingVersion: 1, value: { op: "compaction" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "hold" } },
      },
    ]),
  });
  const observed: string[] = [];
  // When: the projection is submitted through the executor.
  await expect(
    executeCompaction(executionInput(recording.executor, observed)),
  ).rejects.toMatchObject({ code: "compaction_execution_refused", reason: "hold" });
  // Then: neither compaction work nor observations ran.
  expect(observed).toEqual([]);
  expect(recording.committed.every((action) => action.kind === "policy.decision")).toBe(true);
});

it("forwards session cancellation into an in-flight compaction summarizer", async () => {
  // Given: the exact summary-start event and a manually controlled provider.
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<string>();
  const recording = recordingExecutor();
  const observed: string[] = [];
  const base = executionInput(recording.executor, observed);
  let summarySignal: AbortSignal | undefined;
  const pending = executeCompaction({
    ...base,
    signal: controller.signal,
    options: {
      ...base.options,
      onSummarize: async (_messages, _anchor, _budget, signal) => {
        summarySignal = signal;
        started.resolve();
        return released.promise;
      },
    },
  }).then(
    () => "completed",
    (error) => (error instanceof Error ? error.name : "non-error"),
  );
  await started.promise;
  try {
    // When: the session interrupts during summarization.
    controller.abort();
    // Then: cooperative cancellation reaches the real provider boundary.
    expect(summarySignal?.aborted).toBe(true);
    expect(await pending).toBe("AbortError");
    expect(
      recording.committed.some((action) => action.kind === "compaction" && "revert" in action),
    ).toBe(false);
  } finally {
    released.resolve("late summary");
    await pending;
  }
});
