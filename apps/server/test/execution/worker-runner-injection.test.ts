import { describe, expect, it } from "bun:test";
import { PolicyEngine } from "@openomni/agent";
import { InjectionQueue } from "@openomni/openomni";

import { WorkerRunner } from "../../src/execution/worker-runner";
import { createSpawnOptions, createValidRequest, successfulResult } from "./worker-runner-fixture";

describe("WorkerRunner", () => {
  it("wires queued responses into turn-finish prompt injection", async () => {
    const responses: unknown[] = [];
    const injectionQueue = InjectionQueue.create();
    const responseReceived = new Promise<void>((resolve) => {
      const options = createSpawnOptions(
        createValidRequest(),
        (result) => {
          responses.push(result);
          resolve();
        },
        {
          injectionQueue,
          server: {
            async call() {
              throw new Error("unexpected server call");
            },
            notify() {
              // lifecycle notification
            },
          },
          createAgent: (options) => ({
            async run() {
              const drainPolicy = options.middleware?.find(
                (registration) => registration.name === "builtin:injection-queue-drain",
              );
              if (!drainPolicy) throw new Error("injection queue drain policy missing");

              injectionQueue.enqueue(
                "run-1",
                {
                  messageId: "message-1",
                  output: "queued response",
                  timestamp: Date.now(),
                },
                "trace-injection-test",
              );

              const engine = PolicyEngine.create({ audit: false });
              engine.register(drainPolicy);
              const decision = await engine.dispatchPoint("run.turn.post", {
                steps: [],
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                turnCount: 1,
                isCompletion: true,
                continuationCount: 0,
                elapsedMs: 0,
                sessionId: "session-1",
                runId: "run-1",
                turnIndex: 1,
                turnResult: { type: "stop" },
                traceContext: { traceId: "trace-1", runId: "run-1", sessionId: "session-1" },
              });

              expect(decision.effects).toEqual([
                { type: "prompt.inject_message", message: "queued response", role: "assistant" },
              ]);
              expect(injectionQueue.hasPending("run-1")).toBe(false);
              return successfulResult;
            },
          }),
        },
      );

      WorkerRunner.spawnRun(options);
    });

    await responseReceived;

    expect(responses[0]).toMatchObject({ status: "succeeded" });
  });
});
