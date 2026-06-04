import { beforeEach, describe, expect, test } from "bun:test";
import type { Dispatch, Execution, Ingress } from "@openomni/protocol";
import { PendingAskStore, Session, Storage } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { extractText } from "../../src/dispatch/handlers/shared";

function command(
  action: string,
  target: Dispatch.Target,
  payload: unknown = "hello",
): Dispatch.Command {
  return {
    dispatchId: `dispatch-${action}`,
    action,
    target,
    payload,
    actor: { kind: "resident", actorId: "agent:resident", agentName: "resident" },
    traceId: "trace-1",
    submittedAt: Date.now(),
  };
}

function createSessionFixture(id: string): void {
  const now = Date.now();
  Storage.getAdapter().session.set(id, {
    id,
    title: id,
    model: { providerID: "test", modelID: "test" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  });
}

describe("built-in dispatch handlers", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("extractText returns empty string for nullish payloads", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });

  test("worker.spawn is a coordinator dispatch adapter", async () => {
    const requests: Execution.Request[] = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            requests.push(request);
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: "done",
            };
          },
        },
      },
    });

    const result = await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, "build it"),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: "direct", prompt: "build it", agentName: "coder" });
    expect(Session.get(requests[0]?.sessionId ?? "")).toBeDefined();
    expect(result).toMatchObject({ output: { sessionId: requests[0]?.sessionId } });
  });

  test("worker.spawn preserves parent session lineage when provided", async () => {
    const parent = Session.create({
      title: "parent",
      model: { providerID: "test", modelID: "test" },
    });
    let dispatchedSessionId = "";
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(sessionId, request) {
            dispatchedSessionId = sessionId;
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: "done",
            };
          },
        },
      },
    });

    await registry.get("worker.spawn")?.(
      command(
        "worker.spawn",
        { kind: "worker", name: "coder", parentSessionId: parent.id },
        "build",
      ),
    );

    const child = Session.get(dispatchedSessionId);
    expect(child?.parentSessionId).toBe(parent.id);
    expect(child?.spawnDepth).toBe((parent.spawnDepth ?? 0) + 1);
  });

  test("worker send/resume/cancel call coordinator owner methods", async () => {
    const delivered: Array<{ sessionId: string; message: string; runId?: string }> = [];
    const cancelled: string[] = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch() {
            throw new Error("not used");
          },
          async deliverMessage(sessionId, message, runId) {
            delivered.push({ sessionId, message, runId });
            return { accepted: true };
          },
          async cancelRun(runId) {
            cancelled.push(runId);
            return { cancelled: true };
          },
        },
      },
    });

    await registry.get("worker.send")?.(
      command("worker.send", { kind: "worker", sessionId: "s1", runId: "r1" }, "next"),
    );
    await registry.get("worker.resume")?.(
      command("worker.resume", { kind: "worker", sessionId: "s1", runId: "r1" }, "resume"),
    );
    await registry.get("worker.cancel")?.(
      command("worker.cancel", { kind: "worker", runId: "r1" }),
    );

    expect(delivered).toEqual([
      { sessionId: "s1", message: "next", runId: "r1" },
      { sessionId: "s1", message: "resume", runId: "r1" },
    ]);
    expect(cancelled).toEqual(["r1"]);
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

    await expect(
      registry.get("resident.ask")?.(
        command("resident.ask", { kind: "worker", sessionId: "worker-session" }, "question"),
      ),
    ).rejects.toThrow("resident.ask requires resident target");
  });
});
