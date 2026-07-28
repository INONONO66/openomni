import { describe, expect, test } from "bun:test";
import type {
  MessageRecoveryRowV1,
  ProductionScheduleEffectDependencies,
} from "../../src/ledger/production/schedule-effect.js";
import { createProductionScheduleEffectServices } from "../../src/ledger/production/schedule-effect.js";

function dependencies(
  message: MessageRecoveryRowV1,
  failStreamingMessage: ProductionScheduleEffectDependencies["recovery"]["failStreamingMessage"],
  incidents: string[],
): ProductionScheduleEffectDependencies {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected port call");
  };
  return {
    workspaceId: `w1:${"a".repeat(64)}`,
    schedule: { execute: unavailable, query: unavailable },
    queries: {
      effect: async () => undefined,
      attemptByRunId: async () => undefined,
      interruptedAttempts: async () => [],
      interruptedMessages: async () => [message],
      message: async () => message,
    },
    effects: { recordIntent: unavailable, recordSettlement: unavailable },
    recovery: { interruptAttempt: unavailable, failStreamingMessage },
    incidents: { report: ({ code }) => incidents.push(code) },
  };
}

const baseMessage: MessageRecoveryRowV1 = {
  ownerKey: "session:1",
  sessionId: "session-1",
  messageId: "message-1",
  state: { status: "streaming" },
};

describe("production message recovery authority", () => {
  test("fails closed instead of inventing missing surface, role, or model facts", async () => {
    const calls: unknown[] = [];
    const incidents: string[] = [];
    const service = createProductionScheduleEffectServices(
      dependencies(
        baseMessage,
        async (input) => {
          calls.push(input);
          return "committed";
        },
        incidents,
      ),
    );

    await expect(
      service.recovery.messages.reconcileInterruptedMessage({
        sessionId: baseMessage.sessionId,
        messageId: baseMessage.messageId,
      }),
    ).resolves.toBe("unchanged");
    expect(calls).toEqual([]);
    expect(incidents).toEqual(["recovery_transition_rejected"]);
  });

  test("preserves a fully grounded streaming-message recovery without substitution", async () => {
    const calls: Parameters<
      ProductionScheduleEffectDependencies["recovery"]["failStreamingMessage"]
    >[0][] = [];
    const incidents: string[] = [];
    const message: MessageRecoveryRowV1 = {
      ...baseMessage,
      state: {
        status: "streaming",
        surfaceId: "surface-1",
        role: "assistant",
        model: { provider: "provider-1", id: "model-1" },
      },
    };
    const service = createProductionScheduleEffectServices(
      dependencies(
        message,
        async (input) => {
          calls.push(input);
          return "committed";
        },
        incidents,
      ),
    );

    await expect(
      service.recovery.messages.reconcileInterruptedMessage({
        sessionId: message.sessionId,
        messageId: message.messageId,
        requestId: "recovery-request",
      }),
    ).resolves.toBe("recovered");
    expect(calls).toEqual([
      {
        transitionId: "MS-07",
        ownerKey: message.ownerKey,
        sessionId: message.sessionId,
        messageId: message.messageId,
        surfaceId: "surface-1",
        role: "assistant",
        model: { provider: "provider-1", id: "model-1" },
        requestId: "recovery-request",
      },
    ]);
    expect(incidents).toEqual([]);
  });
});
