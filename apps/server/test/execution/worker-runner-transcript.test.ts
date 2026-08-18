import { describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import { Storage, TranscriptStore } from "@openomni/session";

import { WorkerRunner } from "../../src/execution/worker-runner";
import { createSpawnOptions, createValidRequest, successfulResult } from "./worker-runner-fixture";

/**
 * #547 C3 wiring pin: spawnRun is the single wiring point where the llm
 * fact stream (Sink.onFact, #557) meets durable recording — the sink passed
 * to agent.run records every fact for the run's session through
 * TranscriptStore.
 */
describe("WorkerRunner transcript wiring", () => {
  it("records facts arriving on the run sink into the session transcript", async () => {
    const sessionId = "session-1";
    let capturedSink: Sink | undefined;

    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(createValidRequest(), () => resolve(), {
        createAgent: () => ({
          async run(_input, sink) {
            capturedSink = sink;
            // The llm processor offers each folded fact here (#557);
            // simulate the first fact of an attempt.
            sink?.onFact?.({
              type: "message.created",
              attemptId: "msg-1#1",
              message: assistantInfo(sessionId, "msg-1"),
            });
            return successfulResult;
          },
          async *stream() {
            // Unused by spawnRun.
          },
        }),
      });
      // Projection maintenance writes message rows, which reference the
      // session row (FK) — the run's session exists before the run starts.
      const now = Date.now();
      Storage.getAdapter().session.set(sessionId, {
        id: sessionId,
        title: "worker run",
        model: { providerID: "test", modelID: "test" },
        time: { created: now, updated: now },
        spawnDepth: 0,
      });
      WorkerRunner.spawnRun(options);
    });
    await responseReceived;

    expect(typeof capturedSink?.onFact).toBe("function");
    const replayed = TranscriptStore.replay(sessionId);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.info.id).toBe("msg-1");
  });
});

function assistantInfo(sessionID: string, messageID: string): Message.AssistantMessage {
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 1_000 },
    parentID: "user-1",
    modelID: "test",
    providerID: "test",
    agent: "worker",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}
