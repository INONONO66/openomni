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
});
