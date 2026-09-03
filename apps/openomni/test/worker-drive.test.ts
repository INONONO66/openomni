import { expect, test } from "bun:test";
import type { RunInput, Sink } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import type { DelegationKernel } from "../src/delegation/kernel";
import { createChildKernel } from "../src/delegation/process-entry";
import { createInlineWorkerRunner, WorkerRunError } from "../src/delegation/worker-loop";

const ORIGIN = { role: "worker", depth: 1, sessionId: "session-drive" } as const;

function reply(input: RunInput, text: string): Message.WithParts {
  const id = `fake-${input.messages.length}`;
  const sessionID = input.trace.sessionId;
  const tokens = { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: input.model.id,
      providerID: input.model.providerID,
      agent: "worker",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens,
    },
    parts: [
      { id: `${id}-text`, sessionID, messageID: id, type: "text", text } as never,
      {
        id: `${id}-finish`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens,
      },
    ],
  };
}

function bootRunner(run: (input: RunInput, sink: Sink) => Promise<{ type: "stop" }>) {
  let kernel: DelegationKernel;
  const runner = createInlineWorkerRunner({
    model: { provider: "fake", id: "drive-test" },
    apiKey: "test-key",
    llm: {
      resolveProviderModel: async (model) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run,
    },
    kernel: () => kernel,
  });
  kernel = createChildKernel(runner);
  return { runner, stop: () => kernel.stop() };
}

test("an assigned worker claiming BLOCKED is re-driven and believed only on the third recurrence", async () => {
  const prompts: string[][] = [];
  const { runner, stop } = bootRunner(async (input, sink) => {
    prompts.push(input.messages.map((m) => JSON.stringify(m)));
    sink.onMessage(reply(input, "BLOCKED: the registry is unreachable"));
    return { type: "stop" };
  });
  const output = await runner({
    delegationId: "d-drive-1",
    operation: "assign",
    instruction: "publish the package",
    acceptanceCriteria: ["the package is live"],
    origin: ORIGIN,
    signal: new AbortController().signal,
  });
  stop();
  expect(prompts.length).toBe(3);
  expect(prompts[1]?.some((m) => m.includes("Re-verify the blocker"))).toBe(true);
  expect(output.text).toBe("[drive stopped: blocked]\nBLOCKED: the registry is unreachable");
  // Spend accumulates across driven runs: 9 tokens per stubbed run.
  expect(output.tokens).toBe(27);
});

test("an ask run is answered once, never driven — even when the answer says BLOCKED", async () => {
  let runs = 0;
  const { runner, stop } = bootRunner(async (input, sink) => {
    runs += 1;
    sink.onMessage(reply(input, "BLOCKED: cannot answer"));
    return { type: "stop" };
  });
  const output = await runner({
    delegationId: "d-drive-2",
    operation: "ask",
    instruction: "is the registry up?",
    acceptanceCriteria: [],
    origin: ORIGIN,
    signal: new AbortController().signal,
  });
  stop();
  expect(runs).toBe(1);
  expect(output.text).toBe("BLOCKED: cannot answer");
  expect(output.tokens).toBe(9);
});

test("a later worker-run failure carries the active run id", async () => {
  const runIds: string[] = [];
  const { runner, stop } = bootRunner(async (input, sink) => {
    runIds.push(input.trace.runId);
    if (runIds.length === 2) throw new WorkerRunError("second run failed", input.trace.runId);
    sink.onMessage(reply(input, "BLOCKED: retry me"));
    return { type: "stop" };
  });
  const output = await runner({
    delegationId: "d-drive-failure",
    operation: "assign",
    instruction: "retry the task",
    acceptanceCriteria: ["task complete"],
    origin: ORIGIN,
    signal: new AbortController().signal,
  });
  stop();
  expect(runIds.length).toBeGreaterThan(1);
  expect(output.runId).toBe(runIds.at(-1));
  expect(output.runId).not.toBe(runIds[0]);
});

test("an assigned worker that finishes naturally is not nannied", async () => {
  let runs = 0;
  const { runner, stop } = bootRunner(async (input, sink) => {
    runs += 1;
    sink.onMessage(reply(input, "done; the package is live"));
    return { type: "stop" };
  });
  const output = await runner({
    delegationId: "d-drive-3",
    operation: "assign",
    instruction: "publish the package",
    acceptanceCriteria: ["the package is live"],
    origin: ORIGIN,
    signal: new AbortController().signal,
  });
  stop();
  expect(runs).toBe(1);
  expect(output.text).toBe("done; the package is live");
});
