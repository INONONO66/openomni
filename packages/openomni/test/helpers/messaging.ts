import { ActorRegistry } from "@openomni/ledger";
import type { SendInput, SenderTargetGrant } from "../../src/messaging/index.js";

/** Shared messaging-domain fixture builders for openomni tests (#215). */

export const messagingNow = 5_000_000_000_000;

export function registerAgentFixture(
  actorId: string,
  endpoints: readonly { id: string; externalId: string }[] = [],
): void {
  ActorRegistry.registerIdentity({
    id: actorId,
    kind: "ai_agent",
    trustTier: "collaborator",
    createdAt: messagingNow,
    updatedAt: messagingNow,
  });
  for (const endpoint of endpoints) {
    ActorRegistry.registerEndpoint({
      id: endpoint.id,
      actorId,
      channel: "qa",
      externalId: endpoint.externalId,
      createdAt: messagingNow,
      updatedAt: messagingNow,
    });
  }
}

export function buildGrant(
  id: string,
  overrides: Partial<SenderTargetGrant> = {},
): SenderTargetGrant {
  return {
    id,
    senderId: "actor:sender",
    targetActorId: "actor:target",
    operations: ["fire_and_forget", "awaited"],
    ...overrides,
  };
}

export function buildSendInput(overrides: Partial<SendInput> = {}): SendInput {
  return {
    messageId: "message:test",
    senderId: "actor:sender",
    target: { actorId: "actor:target" },
    operation: "fire_and_forget",
    body: "test message",
    at: messagingNow,
    traceId: "trace-messaging",
    ...overrides,
  };
}

export function buildAwaitedSendInput(overrides: Partial<SendInput> = {}): SendInput {
  return buildSendInput({
    messageId: "message:test-awaited",
    operation: "awaited",
    waitSpec: {
      waitId: "wait:test-awaited",
      ownerRef: { kind: "session", id: "session:owner" },
      allowedActions: ["report_result"],
      expectedResponders: ["actor:responder-1", "actor:responder-2", "actor:responder-3"],
      resolutionPolicy: "quorum",
      quorum: { expected: 3, threshold: 2 },
      expiresAt: messagingNow + 600_000,
      followUpWindow: 30_000,
    },
    ...overrides,
  });
}
