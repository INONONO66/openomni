import { describe, expect, test } from "bun:test";
import { Ipc } from "../../src/index.js";

describe("Ipc.Request", () => {
  test("parse round-trip", () => {
    const raw = {
      v: 2,
      type: "request",
      id: "req-1",
      method: "worker.bootstrap_ready",
      params: { workerId: "w1", authToken: "token" },
    };
    const parsed = Ipc.Request.parse(raw);
    const reparsed = Ipc.Request.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("rejects missing id", () => {
    expect(
      Ipc.Request.safeParse({ v: 2, type: "request", method: "worker.bootstrap_ready" }).success,
    ).toBe(false);
  });

  test("rejects wrong version", () => {
    expect(
      Ipc.Request.safeParse({
        v: 1,
        type: "request",
        id: "req-1",
        method: "worker.bootstrap_ready",
      }).success,
    ).toBe(false);
  });

  test("rejects wrong type", () => {
    expect(
      Ipc.Request.safeParse({
        v: 2,
        type: "notification",
        id: "req-1",
        method: "worker.bootstrap_ready",
      }).success,
    ).toBe(false);
  });
});

describe("Ipc.Response", () => {
  test("parse round-trip with result", () => {
    const raw = { v: 2, type: "response", id: "req-1", result: { accepted: true } };
    const parsed = Ipc.Response.parse(raw);
    const reparsed = Ipc.Response.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("parse round-trip with error", () => {
    const raw = {
      v: 2,
      type: "response",
      id: "req-1",
      error: { code: 2000, message: "method not found" },
    };
    const parsed = Ipc.Response.parse(raw);
    const reparsed = Ipc.Response.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("rejects missing id", () => {
    expect(Ipc.Response.safeParse({ v: 2, type: "response", result: null }).success).toBe(false);
  });
});

describe("Ipc.Notification", () => {
  test("parse round-trip", () => {
    const raw = {
      v: 2,
      type: "notification",
      method: "worker.deliver_message",
      params: { sessionId: "sess-1", message: "hello" },
    };
    const parsed = Ipc.Notification.parse(raw);
    const reparsed = Ipc.Notification.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("rejects missing method", () => {
    expect(Ipc.Notification.safeParse({ v: 2, type: "notification" }).success).toBe(false);
  });
});

describe("Ipc helpers", () => {
  test("createRequest produces valid request", () => {
    const req = Ipc.createRequest("worker.bootstrap_ready", { workerId: "w1", authToken: "token" });
    expect(Ipc.Request.safeParse(req).success).toBe(true);
    expect(req.type).toBe("request");
    expect(req.v).toBe(2);
    expect(typeof req.id).toBe("string");
    expect(req.method).toBe("worker.bootstrap_ready");
  });

  test("createRequest without params", () => {
    const req = Ipc.createRequest("coordinator.cancel_run");
    expect(Ipc.Request.safeParse(req).success).toBe(true);
    expect(req.params).toBe(undefined);
  });

  test("createResponse produces valid response", () => {
    const res = Ipc.createResponse("req-1", { accepted: true });
    expect(Ipc.Response.safeParse(res).success).toBe(true);
    expect(res.type).toBe("response");
    expect(res.id).toBe("req-1");
    expect(res.result).toEqual({ accepted: true });
  });

  test("createErrorResponse produces valid error response", () => {
    const res = Ipc.createErrorResponse("req-1", 2000, "method not found");
    expect(Ipc.Response.safeParse(res).success).toBe(true);
    expect(res.error?.code).toBe(2000);
    expect(res.error?.message).toBe("method not found");
    expect(res.result).toBe(undefined);
  });

  test("createNotification produces valid notification", () => {
    const notif = Ipc.createNotification("worker.deliver_message", {
      sessionId: "sess-1",
      message: "hello",
    });
    expect(Ipc.Notification.safeParse(notif).success).toBe(true);
    expect(notif.type).toBe("notification");
    expect(notif.method).toBe("worker.deliver_message");
  });

  test("createNotification without params", () => {
    const notif = Ipc.createNotification("ping");
    expect(Ipc.Notification.safeParse(notif).success).toBe(true);
    expect(notif.params).toBe(undefined);
  });
});

const digest = "a".repeat(64);
const attempt = {
  version: "attempt-ref-v1" as const,
  workItemId: "work-1",
  attemptId: "attempt-1",
  attemptSeq: 1,
};
const authenticatedWorker = {
  authToken: "token",
  workerId: "worker-1",
  generation: 2,
  sessionId: "session-1",
  runId: "run-1",
};
const workerIdentity = {
  version: "authenticated-worker-identity-v1" as const,
  runtimeId: "runtime-1",
  workerId: authenticatedWorker.workerId,
  generation: authenticatedWorker.generation,
  principalId: "principal-1",
  sessionId: authenticatedWorker.sessionId,
  runId: authenticatedWorker.runId,
  attemptId: attempt.attemptId,
};
const credentialRef = {
  version: "credential-source-ref-v1" as const,
  providerId: "anthropic",
  authType: "api" as const,
  credentialId: "credential-1",
  rotationId: "rotation-1",
  sourceKind: "injected_runtime" as const,
  sourcePathDigest: digest,
  credentialDigest: digest,
};
const runtime = {
  runtimeId: workerIdentity.runtimeId,
  workerId: workerIdentity.workerId,
  generation: workerIdentity.generation,
  principalId: workerIdentity.principalId,
  attempt,
  config: {
    configEpoch: "config-1",
    model: { provider: "anthropic", id: "claude-3-5-sonnet-20241022" },
    environment: {
      version: "llm-environment-v1" as const,
      catalogSchemaVersion: 1,
      catalogSource: "bundled" as const,
      catalogSourceVersion: "2026-07-26",
      catalogDigest: digest,
      modelDigest: digest,
      endpoint: {
        version: "llm-endpoint-ref-v1" as const,
        kind: "default" as const,
        valueRef: "provider-default",
        endpointDigest: digest,
      },
      credential: credentialRef,
      sdkPackage: "@ai-sdk/anthropic",
      adapterVersion: "1",
      environmentDigest: digest,
    },
    workspace: {
      canonicalizerVersion: "workspace-v1" as const,
      workspaceId: `w1:${digest}`,
      canonicalBytesDigest: digest,
    },
    agents: [],
    toolCatalog: [],
  },
};
const transitionCommand = {
  version: "kernel-transition-command-v1" as const,
  transitionId: "WT-01",
  command: "kernel.wait.open.v1",
  requestId: "request-1",
  requestHash: digest,
  expectedHead: {
    version: "ledger-head-v1" as const,
    owner: { version: "ledger-owner-v1" as const, ownerKey: "work:work-1" },
    ownerSeq: 0,
    eventHash: "GENESIS_V1" as const,
  },
  payload: {
    version: "native-transition-payload-v1" as const,
    transitionId: "WT-01",
    command: "kernel.wait.open.v1",
    owner: { version: "ledger-owner-v1" as const, ownerKey: "work:work-1" },
    subjectId: "wait-1",
  },
};
const credentialFrame = {
  request: {
    version: "credential-provisioning-request-v1" as const,
    runtimeId: workerIdentity.runtimeId,
    workerId: workerIdentity.workerId,
    generation: workerIdentity.generation,
    principalId: workerIdentity.principalId,
    attempt,
    providerIds: [credentialRef.providerId],
    nonceRef: digest,
    expiresAt: 1_000,
    credentialRefs: [credentialRef],
  },
  channelIdentity: {
    runtimeId: workerIdentity.runtimeId,
    workerId: workerIdentity.workerId,
    generation: workerIdentity.generation,
    principalId: workerIdentity.principalId,
    attempt,
    processId: 42,
    runId: authenticatedWorker.runId,
    sessionId: authenticatedWorker.sessionId,
  },
} satisfies Ipc.CredentialProvisioningFrameV1;
const credentialReceipt = {
  version: "credential-provisioning-receipt-v1" as const,
  runtimeId: workerIdentity.runtimeId,
  workerId: workerIdentity.workerId,
  generation: workerIdentity.generation,
  principalId: workerIdentity.principalId,
  attempt,
  nonceRef: digest,
  acceptedCredentialDigests: [credentialRef.credentialDigest],
  acceptedAtDbMs: 1_001,
};

describe("Ipc.Methods param schemas", () => {
  test("coordinator.spawn_run accepts the final credential-free runtime definition", () => {
    const parsed = Ipc.Methods["coordinator.spawn_run"].params.parse({
      authToken: "token",
      runId: "run-1",
      sessionId: "session-1",
      prompt: "do work",
      runtime,
    });

    expect(parsed.runtime.attempt).toEqual(attempt);
    expect(parsed.runtime.generation).toBe(2);
  });

  test("coordinator.spawn_run rejects provider options and credential-shaped runtime config", () => {
    for (const providerOptions of [
      { Authorization: "Bearer secret" },
      { authorization: "Bearer secret" },
      { apiKey: "sk-secret" },
      { token: "secret" },
      { password: "secret" },
      { proxySecret: "secret" },
      { "proxy-secret": "secret" },
      { baseURL: "https://user:secret@example.com" },
      { headers: { Authorization: "Bearer secret" } },
    ]) {
      const candidate = {
        authToken: "token",
        runId: "run-1",
        sessionId: "session-1",
        prompt: "hello",
        runtime: {
          ...runtime,
          config: { ...runtime.config, providerOptions },
        },
      };

      expect(Ipc.Methods["coordinator.spawn_run"].params.safeParse(candidate).success).toBe(false);
      expect(
        Ipc.Methods["coordinator.spawn_run"].params.safeParse(JSON.parse(JSON.stringify(candidate)))
          .success,
      ).toBe(false);
    }
  });

  test("coordinator.spawn_run rejects raw credentials and incomplete attempt identity", () => {
    const spawn = {
      authToken: "token",
      runId: "run-1",
      sessionId: "session-1",
      prompt: "do work",
      runtime,
    };

    expect(
      Ipc.Methods["coordinator.spawn_run"].params.safeParse({
        ...spawn,
        runtime: { ...runtime, credentials: { ANTHROPIC_API_KEY: "sk-raw" } },
      }).success,
    ).toBe(false);
    expect(
      Ipc.Methods["coordinator.spawn_run"].params.safeParse({
        ...spawn,
        runtime: { ...runtime, attempt: { attemptId: "attempt-1" } },
      }).success,
    ).toBe(false);
  });

  test("worker.kernel_transition accepts generation-bound commands without caller identity", () => {
    expect(
      Ipc.Methods["worker.kernel_transition"].params.safeParse({
        ...authenticatedWorker,
        command: transitionCommand,
      }).success,
    ).toBe(true);
  });

  test("worker.kernel_transition rejects missing generation and caller-supplied identity", () => {
    const { generation: _generation, ...withoutGeneration } = authenticatedWorker;
    expect(
      Ipc.Methods["worker.kernel_transition"].params.safeParse({
        ...withoutGeneration,
        command: transitionCommand,
      }).success,
    ).toBe(false);
    expect(
      Ipc.Methods["worker.kernel_transition"].params.safeParse({
        ...authenticatedWorker,
        command: { ...transitionCommand, identity: workerIdentity },
      }).success,
    ).toBe(false);
  });

  test("worker.kernel_query accepts a generation-bound identity-free query", () => {
    expect(
      Ipc.Methods["worker.kernel_query"].params.safeParse({
        ...authenticatedWorker,
        request: { version: "kernel-query-v1", kind: "authenticated_attempt", attempt },
      }).success,
    ).toBe(true);
  });

  test("worker.kernel_query rejects missing generation and caller-supplied identity", () => {
    const { generation: _generation, ...withoutGeneration } = authenticatedWorker;
    const request = { version: "kernel-query-v1", kind: "authenticated_attempt", attempt };
    expect(
      Ipc.Methods["worker.kernel_query"].params.safeParse({ ...withoutGeneration, request })
        .success,
    ).toBe(false);
    expect(
      Ipc.Methods["worker.kernel_query"].params.safeParse({
        ...authenticatedWorker,
        request: { ...request, identity: workerIdentity },
      }).success,
    ).toBe(false);
  });

  test("worker.observation requires generation and rejects caller-supplied identity", () => {
    const params = {
      ...authenticatedWorker,
      observation: { name: "worker.run.started", data: { attemptId: attempt.attemptId } },
    };
    expect(Ipc.Methods["worker.observation"].params.safeParse(params).success).toBe(true);

    const { generation: _generation, ...withoutGeneration } = params;
    expect(Ipc.Methods["worker.observation"].params.safeParse(withoutGeneration).success).toBe(
      false,
    );
    expect(
      Ipc.Methods["worker.observation"].params.safeParse({ ...params, identity: workerIdentity })
        .success,
    ).toBe(false);
  });

  test("worker.credential_provision carries only a secret-free bound request", () => {
    const parsed = Ipc.Methods["worker.credential_provision"].params.parse({
      workerId: authenticatedWorker.workerId,
      generation: authenticatedWorker.generation,
      runId: authenticatedWorker.runId,
      sessionId: authenticatedWorker.sessionId,
      request: credentialFrame.request,
    });
    expect(parsed.request).toEqual(credentialFrame.request);
    expect(JSON.stringify(parsed)).not.toContain("authenticationTag");
  });

  test("worker.credential_provision rejects missing run/session or mismatched generation", () => {
    const params = {
      workerId: authenticatedWorker.workerId,
      generation: authenticatedWorker.generation,
      runId: authenticatedWorker.runId,
      sessionId: authenticatedWorker.sessionId,
      request: credentialFrame.request,
    };
    const { runId: _runId, ...withoutRun } = params;
    const { sessionId: _sessionId, ...withoutSession } = params;
    const { generation: _generation, ...withoutGeneration } = params;

    for (const invalid of [
      withoutRun,
      withoutSession,
      withoutGeneration,
      { ...params, request: { ...credentialFrame.request, generation: 3 } },
      {
        ...params,
        request: {
          ...credentialFrame.request,
          attempt: { version: "attempt-ref-v1", attemptId: "attempt-1" },
        },
      },
    ]) {
      expect(Ipc.Methods["worker.credential_provision"].params.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  test("worker.credential_provision rejects raw credential material", () => {
    const channel = {
      workerId: authenticatedWorker.workerId,
      generation: authenticatedWorker.generation,
      runId: authenticatedWorker.runId,
      sessionId: authenticatedWorker.sessionId,
    };
    expect(
      Ipc.Methods["worker.credential_provision"].params.safeParse({
        ...channel,
        request: credentialFrame.request,
        credentials: { anthropic: "sk-raw" },
      }).success,
    ).toBe(false);
    expect(
      Ipc.Methods["worker.credential_provision"].params.safeParse({
        ...channel,
        request: { ...credentialFrame.request, apiKey: "sk-raw" },
      }).success,
    ).toBe(false);
  });

  test("worker.credential_provision_ack is strict, secret-free, and fully bound", () => {
    const acknowledgement = {
      workerId: authenticatedWorker.workerId,
      generation: authenticatedWorker.generation,
      processId: 42,
      runId: authenticatedWorker.runId,
      sessionId: authenticatedWorker.sessionId,
      receipt: credentialReceipt,
    };
    const parsed = Ipc.Methods["worker.credential_provision_ack"].params.parse(acknowledgement);

    expect(parsed).toEqual(acknowledgement);
    expect(parsed.receipt.attempt).toEqual(attempt);
    expect(parsed.receipt.nonceRef).toBe(digest);
    expect(parsed.receipt.acceptedCredentialDigests).toEqual([digest]);
    expect(JSON.stringify(parsed)).not.toContain("authToken");
    expect(
      Ipc.Methods["worker.credential_provision_ack"].params.safeParse({
        ...acknowledgement,
        authenticationTag: "forbidden",
      }).success,
    ).toBe(false);
  });

  test("worker.credential_provision_ack rejects missing or mismatched bindings", () => {
    const acknowledgement = {
      workerId: authenticatedWorker.workerId,
      generation: authenticatedWorker.generation,
      processId: 42,
      runId: authenticatedWorker.runId,
      sessionId: authenticatedWorker.sessionId,
      receipt: credentialReceipt,
    };
    const { runId: _runId, ...withoutRun } = acknowledgement;
    const { sessionId: _sessionId, ...withoutSession } = acknowledgement;

    for (const invalid of [
      withoutRun,
      withoutSession,
      { ...acknowledgement, workerId: "worker-forged" },
      { ...acknowledgement, generation: 3 },
      {
        ...acknowledgement,
        receipt: {
          ...credentialReceipt,
          attempt: { version: "attempt-ref-v1", attemptId: "attempt-1" },
        },
      },
    ]) {
      expect(Ipc.Methods["worker.credential_provision_ack"].params.safeParse(invalid).success).toBe(
        false,
      );
    }
  });
});
