import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, SessionHandleStore, Storage } from "@openomni/ledger";
import type { RunInput, Sink } from "@openomni/llm";
import {
  Tool,
  type BusEvent,
  type Gateway,
  type ObservationSink,
  type PlainValue,
} from "@openomni/protocol";
import { createCellRegistry } from "../src/tools/cell-registry";
import { createResident } from "../src/resident";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";

const directory = mkdtempSync(join(tmpdir(), "openomni-resident-tool-wiring-"));

afterEach(() => {
  Storage.reset();
  rmSync(directory, { recursive: true, force: true });
});

function field(value: PlainValue, name: string): PlainValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value[name];
}

function delivery(sessionId: string): Gateway.Deliver {
  const traceId = "1".padStart(32, "0");
  return {
    sessionId,
    event: {
      id: "inbound-tool-wiring",
      traceId,
      surface: "internal",
      userId: "owner",
      payload: "run the tool",
      target: { kind: "resident" },
      mode: "direct",
    },
    decision: {
      traceId,
      time: 1,
      inboundId: "inbound-tool-wiring",
      surface: "internal",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      reason: "test",
      factsUsed: [],
      target: "resident",
      sessionId,
    },
  };
}

test("a resident tool call is executed and observed through the durable executor", async () => {
  const eventNames: string[] = [];
  const observations: ObservationSink = {
    publish<T>(event: BusEvent.Descriptor<T>) {
      eventNames.push(event.name);
    },
  };
  initialize({ dbPath: join(directory, "chat.db"), observationSink: observations });
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("policy rows unavailable");
  policies.append({
    name: "compaction",
    kind: "turn",
    phase: "post",
    match: { encodingVersion: 1, value: { op: "compaction" } },
    verdict: { encodingVersion: 1, value: { type: "allow" } },
    priority: 1000,
    generation: 1,
  });
  const sessionId = "resident-tool-wiring";
  let bodyRuns = 0;
  const resident = createResident({
    model: { provider: "fake", id: "resident-test" },
    apiKey: "test-key",
    tools: {
      cells: {
        registry: createCellRegistry(),
        defaultMachineId: "machine-1",
        async runCell(_machineId, request) {
          bodyRuns += 1;
          return {
            status: "completed",
            cellId: request.cellId,
            value: "ok",
            output: { stdout: "ok", stderr: "" },
          };
        },
        bindTools: () => undefined,
        tools: () => [],
        newCellId: () => "cell-1",
      },
    },
    targets: () => [{ kind: "host", capabilities: [] }],
    sessionRuntime: {
      observations,
      clock: () => 10,
      entropy: (() => {
        let id = 0;
        return () => `runtime-${++id}`;
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
          id: "call-1",
          tool: "run_code",
          input: { code: "1", timeoutMs: 1000 },
        });
        if (result === undefined) return { type: "stop" };
        sink.onMessage(assistantMessage(input, { text: String(result?.output ?? "missing") }));
        return { type: "stop" };
      },
    },
  });

  await resident(delivery(sessionId));

  const tree = SessionHandleStore.tree(sessionId);
  const prompt = tree.find((action) => action.kind === "prompt");
  const turn = tree.find((action) => action.kind === "turn" && action.id !== tree.at(-1)?.id);
  const toolIntent = tree.find(
    (action) => action.kind === "tool" && field(action.intent.value, "phase") === "intent",
  );
  const toolResult = tree.find(
    (action) => action.kind === "tool" && field(action.effect.value, "phase") === "result",
  );
  const decisions = tree.filter((action) => action.kind === "policy.decision");

  expect(bodyRuns).toBe(1);
  expect(turn).toBeDefined();
  expect(toolIntent?.parentId).toBe(turn?.id);
  expect(toolResult?.parentId).toBe(toolIntent?.id);
  expect(decisions.map((action) => field(action.intent.value, "hook")).sort()).toEqual([
    "llm.post",
    "llm.post",
    "llm.pre",
    "llm.pre",
    "prompt.post",
    "prompt.pre",
    "tool.post",
    "tool.pre",
    "turn.post",
    "turn.pre",
  ]);
  expect(
    decisions
      .filter((action) => String(field(action.intent.value, "hook")).startsWith("prompt."))
      .every((action) => action.parentId === prompt?.id),
  ).toBe(true);
  expect(
    decisions
      .filter((action) => !String(field(action.intent.value, "hook")).startsWith("prompt."))
      .every((action) => action.parentId === turn?.id),
  ).toBe(true);
  expect(eventNames.filter((name) => name === Tool.Events.Started.name)).toHaveLength(1);
  expect(eventNames.filter((name) => name === Tool.Events.Completed.name)).toHaveLength(1);
});
