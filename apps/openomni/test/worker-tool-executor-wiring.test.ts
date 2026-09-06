import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, SessionHandleStore, Storage } from "@openomni/ledger";
import type { RunInput, Sink } from "@openomni/llm";
import { Tool, type BusEvent, type ObservationSink, type PlainValue } from "@openomni/protocol";
import { createDelegationKernel } from "../src/delegation/kernel";
import { createInlineWorkerRunner } from "../src/delegation/worker-loop";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";

function field(value: PlainValue, name: string): PlainValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value[name];
}

test("a worker tool call is executed and observed through the durable executor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-worker-tool-wiring-"));
  const observationsSeen: Array<{
    readonly name: string;
    readonly toolCallId: string;
    readonly toolName: string;
  }> = [];
  const observations: ObservationSink = {
    publish<T>(event: BusEvent.Descriptor<T>, data: T) {
      if (event.name === Tool.Events.Started.name) {
        const parsed = Tool.Events.Started.schema.safeParse(data);
        if (parsed.success) {
          observationsSeen.push({
            name: event.name,
            toolCallId: parsed.data.toolCallId,
            toolName: parsed.data.toolName,
          });
        }
      }
      if (event.name === Tool.Events.Completed.name) {
        const parsed = Tool.Events.Completed.schema.safeParse(data);
        if (parsed.success) {
          observationsSeen.push({
            name: event.name,
            toolCallId: parsed.data.toolCallId,
            toolName: parsed.data.toolName,
          });
        }
      }
    },
  };
  initialize({ dbPath: join(directory, "chat.db"), observationSink: observations });
  let bodyRuns = 0;
  const kernel = createDelegationKernel({
    drivers: {
      inline: {
        async run() {
          bodyRuns += 1;
          return { status: "completed", output: "child answer" };
        },
      },
    },
    now: () => 100,
    wake: () => undefined,
    newDelegationId: () => "child-delegation",
    bootSweep: false,
  });

  try {
    const runner = createInlineWorkerRunner({
      model: { provider: "fake", id: "worker-test" },
      apiKey: "test-key",
      kernel: () => kernel,
      sessionRuntime: {
        observations,
        clock: () => 10,
        entropy: (() => {
          let id = 0;
          return () => `worker-runtime-${++id}`;
        })(),
      },
      llm: {
        resolveModel: async (model) => ({
          id: model.id,
          name: model.id,
          providerID: model.provider,
        }),
        run: async (input: RunInput, sink: Sink) => {
          const result = requestToolStep(input, sink, {
            id: "worker-call-1",
            tool: "delegate",
            input: {
              instruction: "answer once",
              operation: "ask",
              scope: "inline",
              timeoutMs: 1000,
            },
          });
          if (result === undefined) return { type: "stop" };
          sink.onMessage(assistantMessage(input, { text: String(result?.output ?? "missing") }));
          return { type: "stop" };
        },
      },
    });
    SessionHandleStore.materialize({
      id: "resident-parent",
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: SessionHandleStore.currentPolicyGeneration(),
      actionId: "resident-parent:configure",
      at: 1,
    });

    await runner({
      delegationId: "worker-session",
      workerRunId: "worker-run",
      operation: "ask",
      instruction: "use one tool",
      acceptanceCriteria: [],
      origin: { role: "worker", depth: 1, sessionId: "resident-parent" },
      signal: new AbortController().signal,
    });

    const tree = SessionHandleStore.tree("worker-session");
    const turn = tree.find(
      (action) => action.kind === "turn" && field(action.intent.value, "phase") === "intent",
    );
    const toolIntent = tree.find(
      (action) => action.kind === "tool" && field(action.intent.value, "phase") === "intent",
    );
    const toolResult = tree.find(
      (action) => action.kind === "tool" && field(action.effect.value, "phase") === "result",
    );

    expect(bodyRuns).toBe(1);
    expect(toolIntent?.parentId).toBe(turn?.id);
    expect(toolResult?.parentId).toBe(toolIntent?.id);
    expect(observationsSeen).toEqual([
      { name: Tool.Events.Started.name, toolCallId: "worker-call-1", toolName: "delegate" },
      { name: Tool.Events.Completed.name, toolCallId: "worker-call-1", toolName: "delegate" },
    ]);
  } finally {
    kernel.stop();
    Storage.reset();
    rmSync(directory, { recursive: true, force: true });
  }
});
