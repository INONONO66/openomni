import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Subagent, type ToolSelection, type WorkerBootstrap } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { SubagentRuntime } from "../../../../subagent/runtime.js";
import { buildToolCatalog } from "../../catalog.js";
import type { NativeTool } from "../../types.js";
import { createWorkerSubagentRuntime } from "./subagent-runtime.js";

let spawnSpy: ReturnType<typeof spyOn> | undefined;
let sendSpy: ReturnType<typeof spyOn> | undefined;

function makeTool(name: string): NativeTool {
  return {
    spec: { name, inputSchema: { type: "object", properties: {} } },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: name === "subagent" ? "agent" : "system",
    execute: async () => ({ id: crypto.randomUUID(), toolCallId: "call", output: "ok" }),
  };
}

function makeRuntime(selection: ToolSelection.Selection) {
  const tools = [makeTool("read"), makeTool("bash"), makeTool("subagent")];
  const catalog = buildToolCatalog([
    { tools: [tools[0], tools[1]], source: "system" as const },
    { tools: [tools[2]], source: "agent" as const },
  ]);
  const definitions = new Map<string, WorkerBootstrap.RuntimeAgentDefinition>([
    [
      "child",
      {
        name: "child",
        description: "child",
        tools: selection,
      },
    ],
  ]);

  return createWorkerSubagentRuntime({
    toolsRef: {
      tools: tools.map((tool) => tool.spec),
      toolExecutor: async () => ({ id: crypto.randomUUID(), toolCallId: "call", output: "ok" }),
    },
    parentSessionId: "parent-session",
    catalogRef: { catalog },
    agentDefinitionsRef: { definitions },
  });
}

describe("createWorkerSubagentRuntime", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    sendSpy?.mockRestore();
  });

  test("spawn respects the child agent tool selection", async () => {
    const runtime = makeRuntime({ categories: ["filesystem"] });
    spawnSpy = spyOn(SubagentRuntime, "spawn").mockResolvedValue({
      sessionId: "child-session",
      runId: "child-run",
      output: "done",
      finishReason: "stop",
    });

    await runtime.spawn({
      agentName: "child",
      title: "child task",
      prompt: "run",
      model: { provider: "test", id: "model" },
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0].tools?.map((tool: { name: string }) => tool.name)).toEqual([
      "read",
    ]);
  });

  test("send resolves tools from the child session metadata and depth", async () => {
    const runtime = makeRuntime({ categories: ["filesystem", "execution"] });
    const root = Session.create({
      title: "root",
      model: { providerID: "test", modelID: "model" },
    });
    const child = Session.createChild({
      parentSessionId: root.id,
      title: "child",
      model: { providerID: "test", modelID: "model" },
      workerMeta: Subagent.ChildSessionMeta.parse({
        kind: "subagent",
        agentName: "child",
        status: "idle",
      }),
    });
    const grandchild = Session.createChild({
      parentSessionId: child.id,
      title: "grandchild",
      model: { providerID: "test", modelID: "model" },
      workerMeta: Subagent.ChildSessionMeta.parse({
        kind: "subagent",
        agentName: "child",
        status: "idle",
      }),
    });
    sendSpy = spyOn(SubagentRuntime, "send").mockResolvedValue({
      sessionId: grandchild.id,
      runId: "child-run",
      output: "done",
      finishReason: "stop",
    });

    await runtime.send({
      sessionId: grandchild.id,
      prompt: "continue",
      model: { provider: "test", id: "model" },
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0].tools?.map((tool: { name: string }) => tool.name)).toEqual([
      "read",
    ]);
  });
});
