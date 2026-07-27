import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Execution, Ipc } from "@openomni/protocol";
import { createProvisioningAuthorizationService } from "../../src/ledger/production/worker-connector.js";

const attempt = {
  version: "attempt-ref-v1" as const,
  workItemId: "work-1",
  attemptId: "attempt-1",
  attemptSeq: 1,
};
const binding = {
  runtimeId: "runtime-1",
  workerId: "worker-1",
  generation: 1,
  principalId: "principal-1",
  processId: 42,
  runId: "run-1",
  sessionId: "session-1",
  attempt,
};
const credentialRef: Execution.CredentialSourceRefV1 = {
  version: "credential-source-ref-v1",
  providerId: "anthropic",
  authType: "api",
  credentialId: "owner-key",
  rotationId: "worker-transfer-1",
  sourceKind: "injected_runtime",
  sourcePathDigest: "a".repeat(64),
  credentialDigest: "b".repeat(64),
};

function effectScope(sourceRef: string): Execution.EffectScopeV1 {
  const workDigest = createHash("sha256").update(attempt.workItemId).digest("hex");
  const sourceDigest = createHash("sha256").update(sourceRef).digest("hex");
  return {
    version: "effect-scope-v1",
    workspace: {
      canonicalizerVersion: "workspace-v1",
      workspaceId: `w1:${workDigest}`,
      canonicalBytesDigest: workDigest,
    },
    resources: [
      {
        version: "resource-scope-v1",
        kind: "registered",
        variant: "kernel_effect.v1",
        targetDigest: sourceDigest,
      },
    ],
    resolver: { id: "production-structural-adapter", version: "1", inputDigest: sourceDigest },
    containment: "none",
    mutationClass: "mutating",
  };
}

function frame(nonceRef = "c".repeat(64)): Ipc.CredentialProvisioningFrameV1 {
  return {
    channelIdentity: binding,
    request: {
      version: "credential-provisioning-request-v1",
      runtimeId: binding.runtimeId,
      workerId: binding.workerId,
      generation: binding.generation,
      principalId: binding.principalId,
      attempt,
      providerIds: [credentialRef.providerId],
      nonceRef,
      expiresAt: 2_000,
      credentialRefs: [credentialRef],
    },
  };
}

function service(
  scope = effectScope(`credential-provisioning:${attempt.attemptId}`),
  confirmationFailure?: Error,
) {
  const confirmations: string[] = [];
  return {
    confirmations,
    service: createProvisioningAuthorizationService({
      model: { provider: "anthropic", id: "claude" },
      now: () => 1_000,
      queries: {
        attempt: async () => ({
          ownerKey: `work:${attempt.workItemId}`,
          sessionId: binding.sessionId,
          runId: binding.runId,
          status: "starting",
          attempt,
          model: { provider: "anthropic", id: "claude" },
          binding,
        }),
        authorization: async () => ({
          ownerKey: `work:${attempt.workItemId}`,
          effectId: `credential-provisioning:${attempt.attemptId}`,
          sourceRef: `credential-provisioning:${attempt.attemptId}`,
          settlement: "pending",
          attempt,
          scope,
        }),
        credentialRef: async () => ({ ...credentialRef, sourceKind: "default_file" as const }),
      },
      transitions: {
        confirmAttemptRunning: async (input) => {
          if (confirmationFailure !== undefined) throw confirmationFailure;
          confirmations.push(input.attempt.attemptId);
        },
      },
    }),
  };
}

function receipt(request: Ipc.CredentialProvisioningFrameV1["request"]) {
  return {
    version: "credential-provisioning-receipt-v1" as const,
    runtimeId: request.runtimeId,
    workerId: request.workerId,
    generation: request.generation,
    principalId: request.principalId,
    attempt: request.attempt,
    nonceRef: request.nonceRef,
    acceptedCredentialDigests: [credentialRef.credentialDigest],
    acceptedAtDbMs: 1_001,
  };
}

describe("production provisioning authorization security", () => {
  test("uses a private immutable claim, consumes it, and rejects nonce aliases", async () => {
    const fixture = service();
    const firstFrame = frame();
    const authorization = await fixture.service.authorize(firstFrame);
    const accepted = receipt(firstFrame.request);
    const acknowledgement = {
      workerId: binding.workerId,
      generation: binding.generation,
      processId: binding.processId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      receipt: accepted,
    };
    const forgedAuthorization = {
      ...authorization,
      request: { ...authorization.request, attempt: { ...attempt, attemptId: "forged" } },
      effect: { ...authorization.effect, effectId: "forged" },
    };

    await fixture.service.confirm(forgedAuthorization, accepted, acknowledgement);
    expect(fixture.confirmations).toEqual([attempt.attemptId]);
    await expect(fixture.service.confirm(authorization, accepted, acknowledgement)).rejects.toThrow(
      "credential provisioning denied",
    );
    await expect(fixture.service.authorize(frame("d".repeat(64)))).rejects.toThrow(
      "credential provisioning denied",
    );
  });

  test("propagates an unexpected confirmation dependency failure after consuming the claim", async () => {
    const dependencyFailure = new Error("ledger unavailable");
    const fixture = service(
      effectScope(`credential-provisioning:${attempt.attemptId}`),
      dependencyFailure,
    );
    const requestFrame = frame();
    const authorization = await fixture.service.authorize(requestFrame);
    const accepted = receipt(requestFrame.request);
    const acknowledgement = {
      workerId: binding.workerId,
      generation: binding.generation,
      processId: binding.processId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      receipt: accepted,
    };

    await expect(fixture.service.confirm(authorization, accepted, acknowledgement)).rejects.toBe(
      dependencyFailure,
    );
    await expect(fixture.service.confirm(authorization, accepted, acknowledgement)).rejects.toThrow(
      "credential provisioning denied",
    );
  });

  test("rejects a schema-valid provisioning effect with the wrong authoritative scope", async () => {
    const validScope = effectScope(`credential-provisioning:${attempt.attemptId}`);
    const hostileScope: Execution.EffectScopeV1 = {
      ...validScope,
      workspace: { ...validScope.workspace, workspaceId: `w1:${"f".repeat(64)}` },
    };
    await expect(service(hostileScope).service.authorize(frame())).rejects.toThrow(
      "credential provisioning denied",
    );
  });
});
