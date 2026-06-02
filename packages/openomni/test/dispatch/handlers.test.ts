import { beforeEach, describe, expect, test } from "bun:test";
import type { Dispatch, Execution, Ingress } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";

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

describe("built-in dispatch handlers", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
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
    const registered: string[] = [];
    const removed: string[] = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        scheduler: {
          register(job) {
            registered.push(`${job.agentName}:${job.schedule}:${job.payload}`);
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

    expect(registered).toEqual(["resident:0 9 * * *:report"]);
    expect(removed).toEqual(["job-1"]);
    expect(createResult).toEqual({
      output: { scheduled: true, jobId: "job-1", messageId: "job-1" },
    });
    expect(cancelResult).toEqual({ output: { cancelled: true, jobId: "job-1" } });
  });

  test("resident.deliver calls resident runtime owner", async () => {
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

    const output = await registry.get("resident.deliver")?.(
      command("resident.deliver", { kind: "resident", sessionId: "resident-session" }, "question"),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      surface: "dispatch",
      payload: "question",
      target: { kind: "resident", sessionId: "resident-session" },
    });
    expect(output).toEqual({
      output: { output: "answer", finishReason: "stop", runId: "resident-run" },
    });
  });
});
