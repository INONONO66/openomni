import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatAgentConfig, ChatAgentInput } from "@openomni/agent";
import { Wait } from "@openomni/protocol";
import { Bus, PendingAskStore, Session, Storage, SurfaceKey, WaitStore } from "@openomni/session";
import { IngressEngine } from "../../src/ingress/engine";
import { ResidentRuntime } from "../../src/resident/runtime";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { extractText } from "../../src/dispatch/handlers/shared";
import { command, createSessionFixture, expectRejectsWithMessage } from "./helpers";

describe("built-in dispatch handlers", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    IngressEngine.clearResidentRuntime();
    IngressEngine.clearAgentResolver();
  });

  test("extractText returns empty string for nullish payloads", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });

  test("schedule handlers call scheduler owner", async () => {
    const registered: Array<{ summary: string; target: string }> = [];
    const removed: string[] = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        scheduler: {
          register(job) {
            registered.push({
              summary: `${job.agentName}:${job.schedule}:${job.payload}`,
              target: job.target.kind,
            });
            return "job-1";
          },
          remove(jobId) {
            removed.push(jobId);
            return true;
          },
        },
      },
    });

    const createResult = await registry.get("schedule.create")?.(
      command(
        "schedule.create",
        { kind: "schedule", name: "resident" },
        { schedule: "0 9 * * *", payload: "report" },
      ),
    );
    const cancelResult = await registry.get("schedule.cancel")?.(
      command("schedule.cancel", { kind: "schedule", id: "job-1" }),
    );

    expect(registered).toEqual([{ summary: "resident:0 9 * * *:report", target: "resident" }]);
    expect(removed).toEqual(["job-1"]);
    expect(createResult).toEqual({
      output: { scheduled: true, jobId: "job-1", messageId: "job-1" },
    });
    expect(cancelResult).toEqual({ output: { cancelled: true, jobId: "job-1" } });
  });

  test("schedule.create rejects non-cron target kinds before registering", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        scheduler: {
          register() {
            throw new Error("should not register invalid target");
          },
          remove() {
            return false;
          },
        },
      },
    });

    expect(() =>
      registry.get("schedule.create")?.(
        command(
          "schedule.create",
          { kind: "system", name: "scheduler" },
          { schedule: "0 9 * * *", payload: "report" },
        ),
      ),
    ).toThrow("schedule.create cannot target system");
  });

  test("resident.ask projects the question and runs the fully resolved Resident AgentDef", async () => {
    createSessionFixture("resident-session");
    createSessionFixture("unrelated-dispatch-surface-session");
    SurfaceKey.register("dispatch:/workspace/resident:", "unrelated-dispatch-surface-session");
    let runConfig: ChatAgentConfig | undefined;
    let runInput: ChatAgentInput | undefined;
    let resolvedWorkspace: string | undefined;
    let executorWorkspace: string | undefined;
    const residentRuntime = new ResidentRuntime({
      runAgent: async (config, input) => {
        runConfig = config;
        runInput = input;
        return { text: "answer", finishReason: "stop" };
      },
    });
    IngressEngine.setResidentRuntime(residentRuntime);
    IngressEngine.setAgentResolver({
      async resolve(_agentName, event) {
        resolvedWorkspace = event.workspace;
        return {
          model: { provider: "test-provider", id: "resident-model" },
          systemPrompt: "Resident system prompt",
          tools: [{ name: "resident_tool", inputSchema: { type: "object" } }],
          toolExecutorFactory: (ctx) => {
            executorWorkspace = ctx.workspaceRoot;
            return async () => {
              throw new Error("tool execution was not expected");
            };
          },
          permissions: { action: "tool.call", allowlist: ["tool:resident_tool"] },
          policyPlan: {
            policies: [
              {
                id: "builtin:tool-permission",
                required: true,
                config: {
                  permission: { action: "tool.call", allowlist: ["tool:resident_tool"] },
                },
              },
            ],
            labels: ["resident"],
          },
          toolConfig: { workspaceRoot: "/workspace/resident" },
          providerOptions: { temperature: 0.2 },
        };
      },
    });
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: { residentRuntime },
    });
    const syncAskPhases: string[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name !== Wait.Events.SyncAsk.name) return;
      syncAskPhases.push(Wait.Events.SyncAsk.schema.parse(payload).phase);
    });

    const output = await registry.get("resident.ask")?.(
      command("resident.ask", { kind: "resident", sessionId: "resident-session" }, "question"),
      { workspaceRoot: "/workspace/resident" },
    );
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    unsubscribe();

    expect(resolvedWorkspace).toBe("/workspace/resident");
    expect(executorWorkspace).toBe("/workspace/resident");
    expect(runInput?.messages).toEqual([{ role: "user", content: "question" }]);
    expect(Session.getMessages("resident-session").length).toBeGreaterThan(0);
    expect(Session.getMessages("unrelated-dispatch-surface-session")).toHaveLength(0);
    expect(runConfig).toMatchObject({
      model: { provider: "test-provider", id: "resident-model" },
      systemPrompt: "Resident system prompt",
      tools: [{ name: "resident_tool", inputSchema: { type: "object" } }],
      providerOptions: { temperature: 0.2 },
    });
    expect(runConfig?.toolExecutor).toBeFunction();
    expect(runConfig?.middleware).toBeDefined();
    // The synchronous ask records audit events only — no PendingAsk and no
    // durable Wait row (#215 owner decision 2).
    expect(syncAskPhases).toEqual(["opened", "answered"]);
    expect(PendingAskStore.get("dispatch-resident.ask")).toBeUndefined();
    expect(WaitStore.list()).toHaveLength(0);
    expect(output).toEqual({
      output: { output: "answer", finishReason: "stop" },
    });
  });

  test("resident.ask rejects non-resident targets before resident runtime", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        residentRuntime: {
          async run() {
            throw new Error("should not run non-resident target");
          },
        },
      },
    });

    await expectRejectsWithMessage(
      () =>
        registry.get("resident.ask")?.(
          command("resident.ask", { kind: "worker", sessionId: "worker-session" }, "question"),
        ),
      "resident.ask requires resident target",
    );
  });

  test("actor.reply delivers external replies to the owning worker run", async () => {
    const deliveries: Array<{ sessionId: string; text: string; runId?: string }> = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch() {
            throw new Error("actor.reply should not spawn workers");
          },
          async deliverMessage(sessionId, text, runId) {
            deliveries.push({ sessionId, text, ...(runId ? { runId } : {}) });
            return { status: "delivered" };
          },
        },
      },
    });

    const output = await registry.get("actor.reply")?.(
      command(
        "actor.reply",
        { kind: "worker", sessionId: "worker-session", runId: "worker-run" },
        "external answer",
      ),
    );

    expect(deliveries).toEqual([
      { sessionId: "worker-session", text: "external answer", runId: "worker-run" },
    ]);
    expect(output).toEqual({
      output: {
        delivered: true,
        sessionId: "worker-session",
        runId: "worker-run",
        result: { status: "delivered" },
      },
    });
  });

  test("outbound handlers call the outbound owner", async () => {
    const calls: Array<{ action: string; endpointId?: string; timeoutMs?: number }> = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        outbound: {
          async dispatch(input) {
            calls.push({
              action: input.command.action,
              endpointId: input.endpointId,
              timeoutMs: input.timeoutMs,
            });
            return { receiptId: `${input.command.action}:receipt` };
          },
        },
      },
    });

    const output = await registry.get("external.ask")?.(
      command("external.ask", { kind: "external_actor", id: "human:advisor" }, "question"),
      { timeoutMs: 250 },
    );

    expect(calls).toEqual([
      { action: "external.ask", endpointId: "human:advisor", timeoutMs: 250 },
    ]);
    expect(output).toEqual({
      output: { receiptId: "external.ask:receipt" },
    });
    expect(registry.has("a2a.ask")).toBe(true);
    expect(registry.has("api.ask")).toBe(true);
  });

  test("outbound handlers fail closed without an outbound owner", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);

    await expectRejectsWithMessage(
      () =>
        registry.get("api.ask")?.(
          command("api.ask", { kind: "external_actor", id: "api:research" }, { query: "lookup" }),
        ),
      "dispatch outbound handler requires outbound owner",
    );
  });

  test("outbound handlers reject non-external targets before owner dispatch", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        outbound: {
          async dispatch() {
            throw new Error("should not dispatch non-external target");
          },
        },
      },
    });

    await expectRejectsWithMessage(
      () => registry.get("a2a.ask")?.(command("a2a.ask", { kind: "resident" }, "hello")),
      "a2a.ask requires external_actor target",
    );
  });

  test("device.command handler calls the device owner", async () => {
    const calls: Array<{ action: string; deviceId: string; timeoutMs?: number }> = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        device: {
          async dispatch(input) {
            calls.push({
              action: input.command.action,
              deviceId: input.deviceId,
              timeoutMs: input.timeoutMs,
            });
            return { receiptId: `${input.deviceId}:accepted` };
          },
        },
      },
    });

    const output = await registry.get("device.command")?.(
      command("device.command", { kind: "system", id: "light.kitchen" }, { state: "off" }),
      { timeoutMs: 250 },
    );

    expect(calls).toEqual([
      { action: "device.command", deviceId: "light.kitchen", timeoutMs: 250 },
    ]);
    expect(output).toEqual({
      output: { receiptId: "light.kitchen:accepted" },
    });
  });

  test("device.command fails closed without a device owner", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);

    await expectRejectsWithMessage(
      () =>
        registry.get("device.command")?.(
          command("device.command", { kind: "system", id: "light.kitchen" }, { state: "off" }),
        ),
      "dispatch device handler requires device owner",
    );
  });

  test("device.command rejects non-system targets before owner dispatch", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        device: {
          async dispatch() {
            throw new Error("should not dispatch non-device target");
          },
        },
      },
    });

    await expectRejectsWithMessage(
      () =>
        registry.get("device.command")?.(
          command("device.command", { kind: "external_actor", id: "light.kitchen" }, "off"),
        ),
      "device.command requires system target",
    );
  });
});
