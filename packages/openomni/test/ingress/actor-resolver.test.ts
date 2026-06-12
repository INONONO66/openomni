import { describe, expect, it } from "bun:test";
import { Ingress as IngressNamespace, Operational, type Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { z } from "zod";
import {
  captureActorPolicy,
  flushBusObservers,
  getIngressEngine,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
  testState,
} from "./_actor-resolver-fixture";

const AuditPayloadSchema = z.object({
  audit: z.object({
    payload: z.object({
      eventId: z.string(),
      actor: z.unknown().optional(),
    }),
  }),
});

setupIngressActorResolverTest();

describe("Ingress actor resolver", () => {
  it("adds canonical actor fields for registered endpoints before inbound policies", async () => {
    // Given
    registerOwnerEndpoint("guild");
    const engine = getIngressEngine();
    let capturedActor: Ingress.Actor | undefined;
    engine.registerIngressPolicy(
      captureActorPolicy((actor) => {
        capturedActor = actor;
      }),
    );
    testState.responseQueue.push("ok");

    // When
    await engine.ingest(
      makeEvent("user-1", {
        id: "user-1",
        role: "manager",
        type: "system",
        trusted: true,
        isTrustedManager: true,
      }),
    );

    // Then
    expect(capturedActor).toMatchObject({
      role: "user",
      id: "user-1",
      actorId: "act_owner",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
      endpointId: "ep_discord_user_1",
    });
    expect(capturedActor).not.toHaveProperty("type");
    expect(capturedActor).not.toHaveProperty("trusted");
    expect(capturedActor).not.toHaveProperty("isTrustedManager");
  });

  it("projects the resolved actor after inbound policy evaluation", async () => {
    // Given
    registerOwnerEndpoint("guild");
    const engine = getIngressEngine();
    let projectedActor: Ingress.Actor | undefined;
    const unobserve = Bus.observe((event, data) => {
      if (event.name !== Operational.Info.name) return;
      const parsed = Operational.Info.schema.parse(data);
      const audit = AuditPayloadSchema.safeParse(parsed.context);
      if (!audit.success) return;
      if (audit.data.audit.payload.eventId !== "event-user-1") return;
      if (audit.data.audit.payload.actor === undefined) return;
      projectedActor = IngressNamespace.ActorSchema.parse(audit.data.audit.payload.actor);
    });
    testState.responseQueue.push("ok");

    try {
      // When
      await engine.ingest(makeEvent("user-1"));
      await flushBusObservers();
    } finally {
      unobserve();
    }

    // Then
    expect(projectedActor).toMatchObject({
      role: "user",
      id: "user-1",
      actorId: "act_owner",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
      endpointId: "ep_discord_user_1",
    });
  });

  it("strips canonical actor fields when endpoint workspace does not match", async () => {
    // Given
    registerOwnerEndpoint("guild-a");
    const engine = getIngressEngine();
    let capturedActor: Ingress.Actor | undefined;
    engine.registerIngressPolicy(
      captureActorPolicy((actor) => {
        capturedActor = actor;
      }),
    );
    testState.responseQueue.push("ok");
    const event = {
      ...makeEvent("user-1", {
        role: "user",
        id: "user-1",
        actorId: "act_spoofed",
        kind: "system",
        type: "system",
        trustTier: "owner",
        trusted: true,
        isTrustedManager: true,
      }),
      workspace: "guild-b",
    };

    // When
    await engine.ingest(event);

    // Then
    expect(capturedActor).toEqual({ role: "user", id: "user-1" });
  });

  it("resolves actor identity when endpoint workspace matches", async () => {
    // Given
    registerOwnerEndpoint("guild");
    const engine = getIngressEngine();
    let capturedActor: Ingress.Actor | undefined;
    engine.registerIngressPolicy(
      captureActorPolicy((actor) => {
        capturedActor = actor;
      }),
    );
    testState.responseQueue.push("ok");

    // When
    await engine.ingest(makeEvent("user-1"));

    // Then
    expect(capturedActor).toMatchObject({
      actorId: "act_owner",
      endpointId: "ep_discord_user_1",
      trustTier: "owner",
      relationship: "owner",
    });
  });
});
