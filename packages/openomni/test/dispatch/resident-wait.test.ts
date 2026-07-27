import { describe, expect, test } from "bun:test";
import { Dispatch } from "@openomni/protocol";
import { requireSuppliedWorkerWait } from "../../src/dispatch/handlers/resident";
import type { DurableWaitV1, WaitKernelService } from "../../src/ingress/wait-correlation";

function command(waitId = "wait-1", workerRunId = "attempt-1") {
  return Dispatch.Command.parse({
    action: "resident.ask",
    target: { kind: "resident", sessionId: "resident-session" },
    payload: "question",
    wait: true,
    correlation: { endpointId: "resident", channelId: "worker-channel", tokenHash: "token-1" },
    idempotencyKey: waitId,
    dispatchId: "dispatch-1",
    actor: {
      kind: "worker",
      actorId: "worker-session:worker-run",
      sessionId: "worker-session",
      runId: "worker-run",
      workerRunId,
      trustTier: "assigned_worker",
      labels: ["actor.worker"],
    },
    sessionId: "worker-session",
    runId: "worker-run",
    submittedAt: 1,
  });
}

function durableWait(waitId = "wait-1"): DurableWaitV1 {
  return {
    waitId,
    revision: "1",
    status: "open",
    route: { kind: "worker", sessionId: "worker-session", runId: "worker-run" },
    opened: {
      version: "wait.opened.v1",
      waitId,
      ownerRef: { version: "wait-owner-ref-v1", kind: "workItem", id: "work-1" },
      expectedResponders: [{ version: "wait-responder-ref-v1", actorId: "resident" }],
      correlation: { version: "wait-correlation-v1", tokenHash: "token-1" },
      allowedActions: ["report_result"],
      resolutionPolicy: "first-response",
      quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
      status: "open",
      deadline: 100,
      partial: false,
      followUpWindow: 0,
      attempt: {
        version: "attempt-ref-v1",
        workItemId: "work-1",
        attemptId: "attempt-1",
        attemptSeq: 1,
      },
    },
  };
}

function waitKernel(wait: DurableWaitV1) {
  let openCalls = 0;
  const service = {
    async open() {
      openCalls += 1;
      return wait;
    },
    async correlate() {
      return {
        kind: "ambiguous" as const,
        candidates: [
          { key: "wait:unrelated" as const, wait: durableWait("unrelated") },
          { key: `wait:${wait.waitId}` as `wait:${string}`, wait },
        ],
      };
    },
  } as unknown as WaitKernelService;
  return { service, openCalls: () => openCalls };
}

describe("resident.ask durable Wait binding", () => {
  test("reuses the exact authenticated Attempt-owned Wait without opening another", async () => {
    const expected = durableWait();
    const kernel = waitKernel(expected);

    const resolved = await requireSuppliedWorkerWait(kernel.service, command());

    expect(resolved).toBe(expected);
    expect(kernel.openCalls()).toBe(0);
  });

  test("rejects a supplied Wait bound to a different authenticated Attempt", async () => {
    const kernel = waitKernel(durableWait());

    await expect(
      requireSuppliedWorkerWait(kernel.service, command("wait-1", "attempt-other")),
    ).rejects.toThrow(
      "resident.ask supplied Wait is not bound to the authenticated Worker Attempt",
    );
    expect(kernel.openCalls()).toBe(0);
  });
});
