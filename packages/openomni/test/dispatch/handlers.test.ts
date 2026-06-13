import { beforeEach, describe, expect, test } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { PendingAskStore, Storage } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { extractText } from "../../src/dispatch/handlers/shared";
import { command, createSessionFixture, expectRejectsWithMessage } from "./helpers";

describe("built-in dispatch handlers", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
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

  test("resident.ask calls resident runtime owner", async () => {
    createSessionFixture("resident-session");
    const calls: Ingress.ResolvedInboundEvent[] = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        residentRuntime: {
          async run(ctx) {
            calls.push(ctx.event);
            return {
              output: "answer",
              finishReason: "stop",
              runId: "resident-run",
              activationId: "activation",
            };
          },
        },
      },
    });

    const output = await registry.get("resident.ask")?.(
      command("resident.ask", { kind: "resident", sessionId: "resident-session" }, "question"),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      surface: "dispatch",
      agentName: "resident",
      payload: "question",
      target: { kind: "resident", sessionId: "resident-session" },
    });
    expect(PendingAskStore.get("dispatch-resident.ask")).toMatchObject({
      status: "answered",
      targetKind: "resident",
    });
    expect(output).toEqual({
      output: { output: "answer", finishReason: "stop", runId: "resident-run" },
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
});
