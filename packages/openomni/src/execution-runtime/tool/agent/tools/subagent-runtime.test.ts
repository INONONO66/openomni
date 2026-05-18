import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PolicyEngine, type PolicyRegistration } from "@openomni/agent";
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

async function evaluateTool(middleware: PolicyRegistration[] | undefined, toolName: string) {
  const engine = PolicyEngine.create({ audit: false });
  for (const registration of middleware ?? []) {
    engine.register(registration);
  }
  return engine.dispatch("invoke.prepare", {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    toolName,
  });
}

function makeRuntime(
  selection: ToolSelection.Selection,
  options: {
    child?: Partial<WorkerBootstrap.RuntimeAgentDefinition>;
    parentPermissions?: WorkerBootstrap.RuntimeAgentDefinition["permissions"];
  } = {},
) {
  const readTool = makeTool("read");
  const bashTool = makeTool("bash");
  const subagentTool = makeTool("subagent");
  const tools = [readTool, bashTool, subagentTool];
  const catalog = buildToolCatalog([
    { tools: [readTool, bashTool], source: "system" as const },
    { tools: [subagentTool], source: "agent" as const },
  ]);
  const definitions = new Map<string, WorkerBootstrap.RuntimeAgentDefinition>([
    [
      "child",
      {
        name: "child",
        description: "child",
        tools: selection,
        ...options.child,
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
    parentPermissions: options.parentPermissions,
    resolveAuth: (provider) =>
      provider === "anthropic"
        ? { type: "proxy", baseURL: "http://localhost:8317/v1", apiKey: "proxy" }
        : undefined,
    allowAuthFallback: false,
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

  test("spawn passes provider auth from the worker bootstrap", async () => {
    const runtime = makeRuntime({ all: true });
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
      model: { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0].auth).toEqual({
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
      apiKey: "proxy",
    });
    expect(spawnSpy.mock.calls[0]?.[0].allowAuthFallback).toBe(false);
  });

  test("spawn prefers bootstrap child system prompt over registry call config", async () => {
    const runtime = makeRuntime({ all: true }, { child: { systemPrompt: "bootstrap prompt" } });
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
      systemPrompt: "registry prompt",
    });

    expect(spawnSpy.mock.calls[0]?.[0].systemPrompt).toBe("bootstrap prompt");
  });

  test("spawn applies child policy plans when legacy permissions are absent", async () => {
    const runtime = makeRuntime(
      { all: true },
      {
        child: {
          policyPlan: {
            policies: [
              {
                id: "builtin:tool-permission",
                required: true,
                config: { permission: { action: "tool.call", allowlist: ["read"] } },
              },
            ],
            labels: ["security"],
          },
        },
      },
    );
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

    expect(spawnSpy.mock.calls[0]?.[0].middleware).toBeUndefined();
    const middleware = spawnSpy.mock.calls[0]?.[0].childMiddleware;
    expect(spawnSpy.mock.calls[0]?.[0].permissions).toBeUndefined();
    expect(spawnSpy.mock.calls[0]?.[0].admissionPermissions).toEqual({
      action: "tool.call",
      allowlist: ["read"],
    });
    await expect(evaluateTool(middleware, "read")).resolves.toMatchObject({
      verdict: "allow",
    });
    await expect(evaluateTool(middleware, "bash")).resolves.toMatchObject({
      verdict: "deny",
    });
  });

  test("spawn keeps parent permissions constraining child policy plans", async () => {
    const runtime = makeRuntime(
      { all: true },
      {
        parentPermissions: { action: "tool.call", allowlist: ["read"] },
        child: {
          policyPlan: {
            policies: [
              {
                id: "builtin:tool-permission",
                required: true,
                config: { permission: { action: "tool.call", allowlist: ["bash"] } },
              },
            ],
            labels: ["security"],
          },
        },
      },
    );
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

    expect(spawnSpy.mock.calls[0]?.[0].middleware).toBeUndefined();
    const middleware = spawnSpy.mock.calls[0]?.[0].childMiddleware;
    expect(spawnSpy.mock.calls[0]?.[0].permissions).toBeUndefined();
    expect(spawnSpy.mock.calls[0]?.[0].admissionPermissions).toEqual({
      action: "tool.call",
      allowlist: [],
      denylist: [],
      denyLabels: [],
      allowLabels: undefined,
      requireApproval: [],
      requireApprovalLabels: [],
      inputRules: [],
    });
    await expect(evaluateTool(middleware, "read")).resolves.toMatchObject({
      verdict: "deny",
    });
    await expect(evaluateTool(middleware, "bash")).resolves.toMatchObject({
      verdict: "deny",
    });
  });

  test("spawn keeps admission middleware separate from child policy plan middleware", async () => {
    const admissionMiddleware: PolicyRegistration[] = [
      {
        name: "parent:admission-only",
        timing: "invoke.prepare",
        priority: 0,
        fn: () => ({
          policyId: "parent:admission-only",
          verdict: "allow",
          reasonCodes: [],
          effects: [],
        }),
      },
    ];
    const runtime = makeRuntime(
      { all: true },
      {
        child: {
          policyPlan: {
            policies: [
              {
                id: "builtin:tool-permission",
                required: true,
                config: { permission: { action: "tool.call", allowlist: ["bash"] } },
              },
            ],
            labels: ["security"],
          },
        },
      },
    );
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
      middleware: admissionMiddleware,
    });

    expect(spawnSpy.mock.calls[0]?.[0].middleware).toBe(admissionMiddleware);
    const childMiddleware = spawnSpy.mock.calls[0]?.[0].childMiddleware as
      | PolicyRegistration[]
      | undefined;
    expect(childMiddleware?.map((registration) => registration.name)).not.toContain(
      "parent:admission-only",
    );
    await expect(evaluateTool(childMiddleware, "read")).resolves.toMatchObject({
      verdict: "deny",
    });
    await expect(evaluateTool(childMiddleware, "bash")).resolves.toMatchObject({
      verdict: "allow",
    });
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
      model: { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0].tools?.map((tool: { name: string }) => tool.name)).toEqual([
      "read",
    ]);
    expect(sendSpy.mock.calls[0]?.[0].auth).toEqual({
      type: "proxy",
      baseURL: "http://localhost:8317/v1",
      apiKey: "proxy",
    });
    expect(sendSpy.mock.calls[0]?.[0].allowAuthFallback).toBe(false);
  });
});
