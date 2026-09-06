import { afterEach, beforeEach, expect, test } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/agent";
import type { RunInput, Sink } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import type { DelegationKernel } from "../src/delegation/kernel";
import { createChildKernel } from "../src/delegation/process-entry";
import { createWorkerSessionRunner, WorkerRunError } from "../src/composition/worker-session";

const ORIGIN = { role: "worker", depth: 1, sessionId: "session-drive" } as const;

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
  SessionHandleStore.materialize({
    id: ORIGIN.sessionId,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
    actionId: "session-drive:configure",
    at: 1,
  });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

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
  let kernelLookups = 0;
  const runner = createWorkerSessionRunner({
    model: { provider: "fake", id: "drive-test" },
    apiKey: "test-key",
    llm: {
      resolveModel: async (model) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run,
    },
    kernel: () => {
      kernelLookups += 1;
      return kernel;
    },
  });
  kernel = createChildKernel(runner);
  return { runner, stop: () => kernel.stop(), kernelLookups: () => kernelLookups };
}

test("an assignment uses one session turn and never treats BLOCKED prose as a runtime verdict", async () => {
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
  expect(prompts.length).toBe(1);
  expect(output.text).toBe("BLOCKED: the registry is unreachable");
  // Spend accumulates across driven runs: 9 tokens per stubbed run.
  expect(output.tokens).toBe(9);
  expect(SessionHandleStore.row("d-drive-1")).toMatchObject({
    parentId: ORIGIN.sessionId,
    role: "worker",
    leaseOwner: null,
    leaseFence: 1,
  });
  expect(SessionHandleStore.row(ORIGIN.sessionId).leaseFence).toBe(0);
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
  const input = {
    delegationId: "d-drive-failure",
    operation: "assign" as const,
    instruction: "work",
    acceptanceCriteria: ["complete"],
    origin: ORIGIN,
    signal: new AbortController().signal,
  };
  await runner(input);
  const failure = await runner(input).catch((error: Error) => error);
  stop();
  expect(failure).toBeInstanceOf(WorkerRunError);
  if (!(failure instanceof WorkerRunError)) throw new Error("missing worker failure");
  expect(runIds).toHaveLength(2);
  expect(runIds.at(-1)).toBe(failure.runId);
  expect(failure.runId).not.toBe(runIds[0]);
});

test("a settled worker binding is released before the durable session runs again", async () => {
  const { runner, stop, kernelLookups } = bootRunner(async (input, sink) => {
    sink.onMessage(reply(input, "done"));
    return { type: "stop" };
  });
  const input = {
    delegationId: "d-rehydrate",
    operation: "ask" as const,
    instruction: "answer",
    acceptanceCriteria: [],
    origin: ORIGIN,
    signal: new AbortController().signal,
  };

  await runner(input);
  await runner(input);
  stop();

  expect(kernelLookups()).toBe(2);
  expect(SessionHandleStore.getSnapshot(input.delegationId, 2).turns).toHaveLength(2);
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
