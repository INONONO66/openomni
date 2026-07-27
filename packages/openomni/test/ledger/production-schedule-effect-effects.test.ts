import { describe, expect, test } from "bun:test";
import { Execution } from "@openomni/protocol";
import {
  createProductionScheduleEffectServices,
  type AttemptExecutionRowV1,
  type EffectRowV1,
  type ProductionScheduleEffectDependencies,
} from "../../src/ledger/production/schedule-effect.js";

const digest = "a".repeat(64);
const environment = {
  version: "llm-environment-v1",
  catalogSchemaVersion: 1,
  catalogSource: "bundled",
  catalogSourceVersion: "1",
  catalogDigest: digest,
  modelDigest: digest,
  endpoint: {
    version: "llm-endpoint-ref-v1",
    kind: "default",
    valueRef: "provider-default",
    endpointDigest: digest,
  },
  credential: {
    version: "credential-source-ref-v1",
    providerId: "provider",
    authType: "api",
    credentialId: "credential",
    rotationId: "rotation",
    sourceKind: "injected_runtime",
    sourcePathDigest: digest,
    credentialDigest: digest,
  },
  sdkPackage: "sdk",
  adapterVersion: "1",
  environmentDigest: digest,
} as const;
const scope = Execution.EffectScopeV1.parse({
  version: "effect-scope-v1",
  workspace: {
    canonicalizerVersion: "workspace-v1",
    workspaceId: `w1:${digest}`,
    canonicalBytesDigest: digest,
  },
  resources: [
    {
      version: "resource-scope-v1",
      kind: "connector",
      installationId: "installation",
      definitionVersion: "1",
    },
    { version: "resource-scope-v1", kind: "endpoint", targetDigest: digest },
  ],
  resolver: { id: "connector-installation-v1", version: "1", inputDigest: digest },
  containment: "connector-declared",
  mutationClass: "unknown",
});
const attempt: AttemptExecutionRowV1 = {
  ownerKey: "work:1",
  workItemId: "work-1",
  attemptId: "attempt-1",
  sessionId: "session-1",
  sourceEventId: "attempt-event",
  state: { runId: "run-1", attemptSeq: 1, status: "succeeded", environment },
};
const effect: EffectRowV1 = {
  ownerKey: attempt.ownerKey,
  workItemId: attempt.workItemId,
  attemptId: attempt.attemptId,
  sourceEventId: "effect-event",
  state: {
    effectId: "effect-1",
    sourceRef: "source-1",
    operation: "connector.submit.v1",
    settlement: "pending",
    attempt: {
      version: "attempt-ref-v1",
      workItemId: attempt.workItemId,
      attemptId: attempt.attemptId,
      attemptSeq: 1,
    },
    scope,
  },
};

function dependencies(existing: EffectRowV1 | undefined): ProductionScheduleEffectDependencies {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected port call");
  };
  return {
    workspaceId: scope.workspace.workspaceId,
    schedule: { execute: unavailable, query: unavailable },
    queries: {
      effect: async () => existing,
      attemptByRunId: async () => attempt,
      interruptedAttempts: async () => [],
      interruptedMessages: async () => [],
      message: async () => undefined,
    },
    effects: { recordIntent: unavailable, recordSettlement: unavailable },
    recovery: { interruptAttempt: unavailable, failStreamingMessage: unavailable },
    incidents: { report: () => undefined },
  };
}

const intent = {
  version: "tool-effect-intent-v1",
  effectId: "effect-1",
  sourceRef: "source-1",
  operation: "connector.submit.v1",
  toolCallId: "call-1",
  execution: { sessionId: "session-1", runId: "run-1" },
  scope,
} as const;

describe("production effect intent authority", () => {
  test("replays canonically equivalent scopes independent of object insertion order", async () => {
    const reorderedScope = {
      mutationClass: scope.mutationClass,
      containment: scope.containment,
      resolver: {
        inputDigest: scope.resolver.inputDigest,
        version: scope.resolver.version,
        id: scope.resolver.id,
      },
      resources: scope.resources.map((resource) => ({ ...resource })),
      workspace: {
        canonicalBytesDigest: scope.workspace.canonicalBytesDigest,
        workspaceId: scope.workspace.workspaceId,
        canonicalizerVersion: scope.workspace.canonicalizerVersion,
      },
      version: scope.version,
    } as Execution.EffectScopeV1;

    await expect(
      createProductionScheduleEffectServices(dependencies(effect)).effects.appendIntent({
        ...intent,
        scope: reorderedScope,
      }),
    ).resolves.toEqual({
      version: "tool-effect-append-receipt-v1",
      status: "accepted",
      receiptId: "effect-event",
    });
  });

  test("rejects a durable intent projected for a different authoritative Attempt", async () => {
    const mismatched = { ...effect, attemptId: "attempt-other" };
    await expect(
      createProductionScheduleEffectServices(dependencies(mismatched)).effects.appendIntent(intent),
    ).resolves.toMatchObject({ status: "rejected" });
  });
});
