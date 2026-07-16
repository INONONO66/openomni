import { beforeEach, describe, expect, test } from "bun:test";
import type { Dispatch as DispatchProtocol, Ingress } from "@openomni/protocol";
import { BlacklistStore, PendingInteractionStore, Session, WorkerRun } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { IngressEngine } from "../../src/ingress/engine";
import { resetKernelRoutingState, routingDecisions } from "./_kernel-routing-fixture";

const correlation = {
  endpointId: "telegram:seller-1",
  channelId: "telegram:dm",
  tokenHash: "token-hash-1",
} satisfies DispatchProtocol.Correlation;

function replyEvent(id: string): Ingress.DirectEvent {
  return {
    id,
    surface: "telegram",
    channel: "telegram:dm",
    userId: "seller-1",
    mode: "direct",
    payload: { action: "report_result", output: "SN-A2334" },
    meta: { correlation },
    agent: {
      model: { provider: "test", id: "test-model" },
      toolConfig: { workspaceRoot: "/trusted/workspace" },
    },
  };
}

async function createPending(id: string, runId: string): Promise<string> {
  const session = Session.create({
    title: id,
    model: { providerID: "test", modelID: "test-model" },
  });
  await WorkerRun.create(session.id, { runId, title: runId, prompt: "complete assigned work" });
  PendingInteractionStore.create({
    id,
    workerRunId: runId,
    sessionId: session.id,
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: { tokenHash: correlation.tokenHash },
    allowedActions: ["report_result"],
    targetActorId: "actor-external-worker",
    expiresAt: Date.now() + 60_000,
    followUpWindow: 60_000,
  });
  return session.id;
}

async function captureError(action: Promise<unknown>): Promise<Error | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

describe("IngressEngine PendingInteraction routing", () => {
  beforeEach(resetKernelRoutingState);

  test("dispatches one exact reply through the injected shared DispatchRuntime", async () => {
    // Given
    const sessionId = await createPending("pi-exact", "run-exact");
    const runtime = new DispatchRuntime();
    const routed: DispatchProtocol.Command[] = [];
    let handlerWorkspaceRoot: string | undefined;
    runtime.register("worker.complete", (command, context) => {
      routed.push(command);
      handlerWorkspaceRoot = context?.workspaceRoot;
      return { output: "accepted" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();

    // When
    let result: Ingress.IngressResult;
    try {
      result = await IngressEngine.ingest(replyEvent("inbound-exact"));
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      sessionId,
      runId: "run-exact",
      pendingInteractionId: "pi-exact",
    });
    expect(routed).toHaveLength(1);
    expect(handlerWorkspaceRoot).toBe("/trusted/workspace");
    expect(result.sessionId).toBe(sessionId);
    expect(PendingInteractionStore.get("pi-exact")?.status).toBe("resolved");
  });

  test("drops a blacklisted endpoint without mutating its exact interaction", async () => {
    // Given
    await createPending("pi-blacklisted", "run-blacklisted");
    BlacklistStore.put({
      id: "blacklist-seller-1",
      kind: "endpoint",
      value: correlation.endpointId,
      createdBy: "actor-owner",
    });
    const runtime = new DispatchRuntime();
    let calls = 0;
    runtime.register("worker.complete", () => {
      calls += 1;
      return { output: "must not execute" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();

    // When
    let error: Error | undefined;
    try {
      error = await captureError(IngressEngine.ingest(replyEvent("inbound-blacklisted")));
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(error).toBeDefined();
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({ stage: "blacklist", outcome: "drop" });
    expect(calls).toBe(0);
    expect(PendingInteractionStore.get("pi-blacklisted")?.status).toBe("open");
  });

  test("does not guess or mutate when exact correlation is ambiguous", async () => {
    // Given
    await createPending("pi-ambiguous-a", "run-ambiguous-a");
    await createPending("pi-ambiguous-b", "run-ambiguous-b");
    const runtime = new DispatchRuntime();
    let calls = 0;
    runtime.register("worker.complete", () => {
      calls += 1;
      return { output: "must not execute" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();

    // When
    let error: Error | undefined;
    try {
      error = await captureError(IngressEngine.ingest(replyEvent("inbound-ambiguous")));
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(error).toBeDefined();
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: ["pi-ambiguous-a", "pi-ambiguous-b"],
    });
    expect(calls).toBe(0);
    expect(PendingInteractionStore.get("pi-ambiguous-a")?.status).toBe("open");
    expect(PendingInteractionStore.get("pi-ambiguous-b")?.status).toBe("open");
  });

  test("leaves an authorized exact interaction open when no handler is selected", async () => {
    // Given
    await createPending("pi-no-handler", "run-no-handler");
    IngressEngine.setDispatchRuntime(new DispatchRuntime());
    const observed = routingDecisions();

    // When
    let error: Error | undefined;
    try {
      error = await captureError(IngressEngine.ingest(replyEvent("inbound-no-handler")));
    } finally {
      observed.unsubscribe();
    }

    // Then
    expect(error).toBeDefined();
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      pendingInteractionId: "pi-no-handler",
    });
    expect(PendingInteractionStore.get("pi-no-handler")?.status).toBe("open");
  });

  test("does not expose structured Dispatch handler output as channel text", async () => {
    // Given
    await createPending("pi-structured-output", "run-structured-output");
    const runtime = new DispatchRuntime();
    runtime.register("worker.complete", () => ({ output: { internal: "result" } }));
    IngressEngine.setDispatchRuntime(runtime);

    // When
    const result = await IngressEngine.ingest(replyEvent("inbound-structured-output"));

    // Then
    expect(result.result.output).toBe("");
    expect(PendingInteractionStore.get("pi-structured-output")?.status).toBe("resolved");
  });
});
