import { beforeEach, describe, expect, test } from "bun:test";
import { Ingress, type Command, type Gateway, type Wait } from "@openomni/protocol";
import { createGatewayRouter } from "@openomni/channels";
import { createBrainEngine, ResidentRuntime } from "@openomni/openomni";
import { DispatchRuntime } from "@openomni/openomni";
import { ActorRegistry, Session, Storage, WaitStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";

/**
 * Composed gateway↔brain pipeline (#707): the seam-integration pins that the
 * split kernel-routing-waits suite (router half in channels, dispatch half in
 * openomni) can no longer carry alone — one external event travels
 * router.ingest → Gateway.Deliver → brainEngine.deliver end to end, exactly
 * as apps/server wires it in bootstrap.
 */

const correlation = {
  endpointId: "telegram:seller-1",
  channelId: "telegram:dm",
  tokenHash: "token-hash-1",
} satisfies Wait.Correlation;

function replyEvent(
  id: string,
  payload: unknown = { action: "report_result", output: "SN-A2334" },
): Gateway.DeliveredEvent {
  return {
    id,
    traceId: "trace-test",
    surface: "telegram",
    channel: "telegram:dm",
    userId: "seller-1",
    mode: "direct",
    payload,
    meta: { correlation },
  };
}

function registerResponder(actorId: string, externalId: string): void {
  ActorRegistry.registerIdentity({ id: actorId, kind: "human", trustTier: "assigned_worker" });
  ActorRegistry.registerEndpoint({
    id: `telegram:${externalId}`,
    actorId,
    channel: "telegram",
    externalId,
  });
}

describe("gateway → brain composed pipeline", () => {
  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("delivers a durable-wait owner reply into the resident run and materializes the owner session lazily", async () => {
    registerResponder("actor-external-worker", "seller-1");
    // The wait owner's session id is a label the gateway recorded — the row
    // itself materializes brain-side on first Deliver (crash-converged).
    const ownerSessionId = crypto.randomUUID();
    WaitStore.create(
      {
        id: "wait-composed",
        ownerRef: { kind: "session", id: ownerSessionId },
        originMessageId: "out-wait-composed",
        correlation: { channelId: correlation.channelId, tokenHash: correlation.tokenHash },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-external-worker"],
        resolutionPolicy: "first_reply",
        expiresAt: Number.MAX_SAFE_INTEGER,
        followUpWindow: 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      "trace-test",
    );
    const executions: string[] = [];
    const brain = createBrainEngine({
      residentRuntime: ResidentRuntime.create({
        runAgent: async () => {
          executions.push("executed");
          return { text: "resident response", finishReason: "stop" };
        },
      }),
      externalAgentResolver: async () => ({ model: { provider: "test", id: "test-model" } }),
    });
    const router = createGatewayRouter({ sink: Bus.publish, deliver: brain.deliver });

    const result = await router.ingest(replyEvent("inbound-composed-wait"));

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(ownerSessionId);
    expect(result.result.output).toBe("resident response");
    expect(executions).toEqual(["executed"]);
    expect(WaitStore.get("wait-composed")).toMatchObject({ status: "resolved" });
    // Lazy materialization: the brain created the owner session row on the
    // first Deliver with the gateway's label as its id.
    expect(Session.get(ownerSessionId)).toMatchObject({ id: ownerSessionId });
  });

  test("routes a frozen pending-interaction reply through the brain's dispatch placement", async () => {
    registerResponder("actor-external-worker", "seller-1");
    const session = Session.create({
      traceId: "trace-test",
      title: "pi-composed",
      model: { providerID: "test", modelID: "test-model" },
    });
    const workerRunAdapter = Storage.getAdapter().workerRunState;
    if (!workerRunAdapter) throw new Error("workerRunState sub-adapter missing");
    workerRunAdapter.create(session.id, {
      runId: "run-composed",
      agentName: "worker",
      status: "waiting_input",
      executorKind: "connector_endpoint",
      title: "run-composed",
      prompt: "complete assigned work",
    });
    const pendingAdapter = Storage.getAdapter().pendingInteraction;
    if (!pendingAdapter) throw new Error("pendingInteraction adapter missing");
    pendingAdapter.create({
      id: "pi-composed",
      workerRunId: "run-composed",
      sessionId: session.id,
      endpointId: correlation.endpointId,
      channelId: correlation.channelId,
      correlation: { tokenHash: correlation.tokenHash },
      allowedActions: ["report_result"],
      targetActorId: "actor-external-worker",
      status: "open",
      expiresAt: Number.MAX_SAFE_INTEGER,
      followUpWindow: 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const runtime = new DispatchRuntime();
    const routed: Command.Request[] = [];
    let handlerWorkspaceRoot: string | undefined;
    runtime.register("worker.complete", (command, context) => {
      routed.push(command);
      handlerWorkspaceRoot = context?.workspaceRoot;
      return { output: "accepted" };
    });
    const brain = createBrainEngine({
      dispatchRuntime: runtime,
      externalAgentResolver: async () => ({
        model: { provider: "test", id: "test-model" },
        toolConfig: { workspaceRoot: "/trusted/workspace" },
      }),
    });
    const decisions: unknown[] = [];
    const router = createGatewayRouter({
      sink: (event, data) => {
        if (event.name === "ingress.routing.decision") decisions.push(data);
        Bus.publish(event, data);
      },
      deliver: brain.deliver,
    });

    const result = await router.ingest(replyEvent("inbound-composed-pi"));

    expect(decisions).toHaveLength(1);
    expect(Ingress.Events.RoutingDecision.schema.parse(decisions[0])).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      sessionId: session.id,
      runId: "run-composed",
      pendingInteractionId: "pi-composed",
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      action: "worker.complete",
      sessionId: session.id,
      runId: "run-composed",
      actor: { trustTier: "assigned_worker" },
    });
    // The resolver-supplied AgentDef (bootstrap's buildResidentAgentDef
    // equivalent) carries the trusted workspace to the handler context — the
    // pre-flip bridge-embedded behavior, preserved across the seam.
    expect(handlerWorkspaceRoot).toBe("/trusted/workspace");
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(session.id);
  });
});
