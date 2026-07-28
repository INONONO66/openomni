import fs from "node:fs";
import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import type { Ipc } from "@openomni/protocol";
import {
  WorkerSupervisor,
  type WorkerCredentialProvisioningSigner,
  type WorkerRuntimeDefinitionPort,
} from "../../src/worker-supervision/supervisor";
import { handleWorkerRequest } from "../../src/worker-supervision/supervisor-requests";
import {
  closeWorkerPrivatePipe,
  createWorkerBootstrapChallenge,
  createWorkerGenerationKeySigner,
  isBootstrapAccepted,
  isWorkerBootstrapProof,
  workerBootstrapProof,
  writeWorkerGenerationKey,
  writeWorkerPrivateFrame,
} from "../../src/worker-supervision/supervisor-process";

type Context = Parameters<typeof handleWorkerRequest>[3];

function context(overrides: Partial<Context> = {}): Context {
  return {
    authToken: "generation-secret",
    runtimeId: "runtime-1",
    principalId: "principal-1",
    workerId: 7,
    generation: 3,
    processId: 4242,
    isChannelAuthenticated: () => true,
    activeToolCalls: new Map(),
    activeInboundWaitCalls: new Map(),
    runtimeForRun: (runId, sessionId) =>
      runId === "run-1" && sessionId === "session-1" ? workerRuntime() : undefined,
    kernelTransition: async () => ({
      version: "kernel-transition-result-v1",
      status: "rejected",
      code: "transition_forbidden",
    }),
    kernelQuery: async () => ({
      version: "kernel-query-result-v1",
      kind: "authenticated_transcript",
      messages: [],
    }),
    observation: async () => undefined,
    provisionCredentials: async (frame, _signer) => ({
      privateFrame: new Uint8Array([1, 2, 3]),
      receipt: {
        version: "credential-provisioning-receipt-v1",
        runtimeId: frame.request.runtimeId,
        workerId: frame.request.workerId,
        generation: frame.request.generation,
        principalId: frame.request.principalId,
        attempt: frame.request.attempt,
        nonceRef: frame.request.nonceRef,
        acceptedCredentialDigests: frame.request.credentialRefs.map(
          (credential) => credential.credentialDigest,
        ),
        acceptedAtDbMs: 100,
      },
      acknowledge: async () => undefined,
    }),
    takeProvisioningSigner: (attempt) =>
      createWorkerGenerationKeySigner(new Uint8Array(32).fill(1), {
        runtimeId: "runtime-1",
        workerId: "7",
        generation: 3,
        principalId: "principal-1",
        attempt,
        processId: 4242,
      }),
    writePrivateFrame: () => undefined,
    credentialProvisioningState: "available",
    pendingCredentialProvisioning: undefined,
    ...overrides,
  };
}

function request(
  method: string,
  params: Record<string, unknown>,
  requestContext: Context,
): Promise<unknown> {
  return new Promise((resolve) => handleWorkerRequest(method, params, resolve, requestContext));
}

const authenticated = {
  authToken: "generation-secret",
  workerId: "7",
  generation: 3,
  sessionId: "session-1",
  runId: "run-1",
};

const digest = "a".repeat(64);
const credentialRequest = {
  version: "credential-provisioning-request-v1",
  runtimeId: "runtime-1",
  workerId: "7",
  generation: 3,
  principalId: "principal-1",
  attempt: {
    version: "attempt-ref-v1",
    workItemId: "work-1",
    attemptId: "attempt-1",
    attemptSeq: 1,
  },
  providerIds: ["openai"],
  nonceRef: digest,
  expiresAt: 100,
  credentialRefs: [
    {
      version: "credential-source-ref-v1",
      providerId: "openai",
      authType: "api",
      credentialId: "owner-openai",
      rotationId: "rotation-1",
      sourceKind: "default_file",
      sourcePathDigest: digest,
      credentialDigest: digest,
    },
  ],
} satisfies Ipc.CredentialProvisioningFrameV1["request"];

const credentialParams = {
  workerId: "7",
  generation: 3,
  runId: "run-1",
  sessionId: "session-1",
  request: credentialRequest,
};

function workerRuntime(
  overrides: Partial<Ipc.WorkerRuntimeDefinitionV1> = {},
): Ipc.WorkerRuntimeDefinitionV1 {
  return {
    runtimeId: "runtime-1",
    workerId: "7",
    generation: 3,
    principalId: "principal-1",
    attempt: { ...credentialRequest.attempt, version: "attempt-ref-v1" },
    config: {
      configEpoch: "config-1",
      model: { provider: "anthropic", id: "claude-test" },
      environment: {
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
          providerId: "anthropic",
          authType: "api",
          credentialId: "credential-1",
          rotationId: "rotation-1",
          sourceKind: "injected_runtime",
          sourcePathDigest: digest,
          credentialDigest: digest,
        },
        sdkPackage: "@ai-sdk/anthropic",
        adapterVersion: "1",
        environmentDigest: digest,
      },
      workspace: {
        canonicalizerVersion: "workspace-v1",
        workspaceId: `w1:${digest}`,
        canonicalBytesDigest: digest,
      },
      agents: [],
      toolCatalog: [],
    },
    ...overrides,
  };
}

function deliverySupervisor(runtimeDefinition?: WorkerRuntimeDefinitionPort) {
  const call = mock(async (_method: string, params: unknown, _timeoutMs: number) => {
    const request = params as { runId: string; sessionId: string };
    return {
      runId: request.runId,
      sessionId: request.sessionId,
      status: "succeeded" as const,
      output: "fixture complete",
      finishReason: "stop",
    };
  });
  const supervisor = Object.create(WorkerSupervisor.prototype) as WorkerSupervisor;
  Object.assign(supervisor, {
    id: 7,
    authToken: "generation-secret",
    runtimeId: "runtime-1",
    principalId: "principal-1",
    generation: 3,
    running: true,
    bootstrapped: true,
    proc: { pid: 4242 },
    activeRuntimeDefinitions: new Map(),
    client: { connected: true, call },
    runtimeDefinition,
  });
  return { call, supervisor };
}

function liveSupervisor(events: string[] = []): WorkerSupervisor {
  return new WorkerSupervisor({
    id: 7,
    script: path.join(import.meta.dir, "../harness/worker-fixture.ts"),
    runtimeId: "runtime-1",
    principalId: "principal-1",
    bootstrap: { configEpoch: "test-config" },
    socketDir: fs.mkdtempSync("/tmp/openomni-supervisor-test-"),
    events: {
      publish(type) {
        events.push((type as { name: string }).name);
      },
    },
    runtimeDefinition: async (binding) =>
      workerRuntime({
        runtimeId: binding.runtimeId,
        workerId: binding.workerId,
        generation: binding.generation,
        principalId: binding.principalId,
      }),
  });
}
describe("worker supervisor authenticated relays", () => {
  test("routes a generation-bound kernel transition without choosing its target", async () => {
    const kernelTransition = mock(async (_frame: unknown) => ({
      version: "kernel-transition-result-v1" as const,
      status: "rejected" as const,
      code: "transition_forbidden" as const,
    }));
    const params = {
      ...authenticated,
      command: {
        version: "kernel-transition-command-v1",
        transitionId: "SS-01",
        command: "messaging.session.open.v1",
        requestId: "request-1",
        requestHash: digest,
        expectedHead: {},
        payload: {},
      },
    };

    const result = await request(
      "worker.kernel_transition",
      params,
      context({ kernelTransition: kernelTransition as never }),
    );

    expect(kernelTransition).toHaveBeenCalledTimes(1);
    expect(kernelTransition.mock.calls[0]?.[0]).toMatchObject({
      channelIdentity: {
        runtimeId: "runtime-1",
        workerId: "7",
        generation: 3,
        principalId: "principal-1",
        processId: 4242,
      },
      request: {
        workerId: "7",
        generation: 3,
        sessionId: "session-1",
        runId: "run-1",
      },
    });
    expect(result).toMatchObject({ status: "rejected" });
  });

  test("rejects a forged generation before invoking an injected port", async () => {
    const kernelQuery = mock(async () => ({}));

    const result = await request(
      "worker.kernel_query",
      { ...authenticated, generation: 2, request: { version: "kernel-query-v1" } },
      context({ kernelQuery: kernelQuery as never }),
    );

    expect(kernelQuery).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "unauthorized worker request" });
  });

  test("rejects unsupported methods instead of providing a generic authority escape hatch", async () => {
    const result = await request("worker.kernel_append", authenticated, context());

    expect(result).toEqual({
      ok: false,
      error: "unsupported worker IPC method: worker.kernel_append",
    });
  });

  test("sends a secret-free bound request once and returns only its receipt", async () => {
    const privateFrame = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const receipt = {
      version: "credential-provisioning-receipt-v1" as const,
      runtimeId: "runtime-1",
      workerId: "7",
      generation: 3,
      principalId: "principal-1",
      attempt: credentialRequest.attempt,
      nonceRef: digest,
      acceptedCredentialDigests: [digest],
      acceptedAtDbMs: 100,
    };
    const acknowledge = mock(
      async (_ack: Ipc.CredentialProvisioningAcknowledgementV1) => undefined,
    );
    const provisionCredentials = mock(
      async (
        _frame: Ipc.CredentialProvisioningFrameV1,
        _signer: WorkerCredentialProvisioningSigner,
      ) => ({
        privateFrame,
        receipt,
        acknowledge,
      }),
    );
    const writePrivateFrame = mock((frame: Uint8Array) => frame.fill(0));
    const requestContext = context({
      provisionCredentials: provisionCredentials as never,
      writePrivateFrame,
    });
    const params = credentialParams;

    const result = await request("worker.credential_provision", params, requestContext);
    const acknowledgement = {
      workerId: "7",
      generation: 3,
      processId: 4242,
      runId: "run-1",
      sessionId: "session-1",
      receipt,
    };
    const acknowledged = await request(
      "worker.credential_provision_ack",
      acknowledgement,
      requestContext,
    );
    const replay = await request(
      "worker.credential_provision_ack",
      acknowledgement,
      requestContext,
    );

    expect(provisionCredentials).toHaveBeenCalledTimes(1);
    expect(provisionCredentials.mock.calls[0]?.[0]).toEqual({
      request: credentialRequest,
      channelIdentity: {
        runtimeId: "runtime-1",
        workerId: "7",
        generation: 3,
        principalId: "principal-1",
        attempt: credentialRequest.attempt,
        processId: 4242,
        runId: "run-1",
        sessionId: "session-1",
      },
    });
    expect(provisionCredentials.mock.calls[0]?.[1]).toBeDefined();
    expect(writePrivateFrame).toHaveBeenCalledTimes(1);
    expect(result).toEqual(receipt);
    expect(JSON.stringify(params)).not.toContain("authenticationTag");
    expect(JSON.stringify(params)).not.toContain("generation-secret");
    expect(JSON.stringify(params)).not.toContain("privateFrame");
    expect(JSON.stringify(result)).not.toContain("privateFrame");
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(acknowledgement);
    expect(acknowledged).toEqual({ accepted: true });
    expect(replay).toEqual({
      ok: false,
      error: "credential provisioning acknowledgement denied",
    });
  });

  test("rejects a forged credential acknowledgement and consumes its one-shot state", async () => {
    const acknowledge = mock(async () => undefined);
    const requestContext = context({
      provisionCredentials: async (_frame, _signer) => ({
        privateFrame: new Uint8Array([1]),
        receipt: {
          version: "credential-provisioning-receipt-v1",
          runtimeId: "runtime-1",
          workerId: "7",
          generation: 3,
          principalId: "principal-1",
          attempt: credentialRequest.attempt,
          nonceRef: digest,
          acceptedCredentialDigests: [digest],
          acceptedAtDbMs: 100,
        },
        acknowledge,
      }),
    });
    await request("worker.credential_provision", credentialParams, requestContext);
    const acknowledgement = {
      workerId: "7",
      generation: 3,
      processId: 4242,
      runId: "run-1",
      sessionId: "session-1",
      receipt: {
        version: "credential-provisioning-receipt-v1" as const,
        runtimeId: "runtime-1",
        workerId: "7",
        generation: 3,
        principalId: "principal-1",
        attempt: credentialRequest.attempt,
        nonceRef: digest,
        acceptedCredentialDigests: [digest],
        acceptedAtDbMs: 100,
      },
    };

    const forged = await request(
      "worker.credential_provision_ack",
      { ...acknowledgement, processId: 4243 },
      requestContext,
    );
    const retry = await request("worker.credential_provision_ack", acknowledgement, requestContext);

    expect(acknowledge).not.toHaveBeenCalled();
    expect(forged).toEqual({
      ok: false,
      error: "credential provisioning acknowledgement denied",
    });
    expect(retry).toEqual({
      ok: false,
      error: "credential provisioning acknowledgement denied",
    });
  });

  test("rejects wrong run, session, or Attempt before taking the one-shot signer", async () => {
    const takeProvisioningSigner = mock(() => {
      throw new Error("signer must not be consumed");
    });
    const provisionCredentials = mock(async () => {
      throw new Error("credential material must not be requested");
    });
    const mismatches = [
      { ...credentialParams, runId: "run-2" },
      { ...credentialParams, sessionId: "session-2" },
      {
        ...credentialParams,
        request: {
          ...credentialRequest,
          attempt: { ...credentialRequest.attempt, attemptId: "attempt-2" },
        },
      },
    ];

    for (const params of mismatches) {
      const result = await request(
        "worker.credential_provision",
        params,
        context({
          takeProvisioningSigner: takeProvisioningSigner as never,
          provisionCredentials: provisionCredentials as never,
        }),
      );
      expect(result).toEqual({
        ok: false,
        error: "credential provisioning identity mismatch",
      });
    }

    expect(takeProvisioningSigner).not.toHaveBeenCalled();
    expect(provisionCredentials).not.toHaveBeenCalled();
  });

  test("rejects credential provisioning forged for another generation", async () => {
    const provisionCredentials = mock(async () => ({}));
    const result = await request(
      "worker.credential_provision",
      { ...credentialParams, generation: 2 },
      context({ provisionCredentials: provisionCredentials as never }),
    );

    expect(provisionCredentials).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "unauthorized worker request" });
  });

  test("rejects credential provisioning on an unauthenticated channel", async () => {
    const provisionCredentials = mock(async () => ({}));
    const result = await request(
      "worker.credential_provision",
      credentialParams,
      context({
        isChannelAuthenticated: () => false,
        provisionCredentials: provisionCredentials as never,
      }),
    );

    expect(provisionCredentials).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "unauthorized worker request" });
  });

  test("writes the generation key followed by one length-prefixed opaque frame and scrubs both", () => {
    const writes: Uint8Array[] = [];
    let closes = 0;
    const stdin = {
      write(value: Uint8Array) {
        writes.push(value.slice());
        return value.byteLength;
      },
      flush() {
        return undefined;
      },
      end() {
        closes += 1;
      },
    };
    const proc = { stdin } as never;
    const generationKey = new Uint8Array(32).fill(0x11);
    const privateFrame = new Uint8Array([0x73, 0x65, 0x63, 0x72, 0x65, 0x74]);

    writeWorkerGenerationKey(proc, generationKey);
    writeWorkerPrivateFrame(proc, privateFrame);
    expect(closes).toBe(0);
    closeWorkerPrivatePipe(proc);

    expect(writes).toHaveLength(3);
    expect(writes[0]).toEqual(new Uint8Array(32).fill(0x11));
    const lengthPrefix = writes[1];
    if (!lengthPrefix) throw new Error("private frame length prefix was not written");
    expect(new DataView(lengthPrefix.buffer).getUint32(0, false)).toBe(6);
    expect(writes[2]).toEqual(new Uint8Array([0x73, 0x65, 0x63, 0x72, 0x65, 0x74]));
    expect(generationKey.every((byte) => byte === 0)).toBe(true);
    expect(privateFrame.every((byte) => byte === 0)).toBe(true);
    expect(closes).toBe(1);
  });
});

describe("worker supervisor runtime composition", () => {
  test("injects only the validated runtime returned for the process binding", async () => {
    const expectedRuntime = workerRuntime();
    const runtimeDefinition = mock(async () => expectedRuntime);
    const { call, supervisor } = deliverySupervisor(runtimeDefinition);

    await supervisor.deliver("run-1", {
      sessionId: "session-1",
      prompt: "hello",
      traceId: "must-not-cross-the-port",
      credentials: { apiKey: "must-not-cross-the-port" },
      sourcePath: "/must-not-cross-the-port",
      database: { url: "must-not-cross-the-port" },
      modelFallback: "must-not-cross-the-port",
    });

    expect(runtimeDefinition).toHaveBeenCalledWith(
      {
        runtimeId: "runtime-1",
        workerId: "7",
        generation: 3,
        principalId: "principal-1",
        processId: 4242,
      },
      { runId: "run-1", sessionId: "session-1", prompt: "hello" },
    );
    expect(call).toHaveBeenCalledWith(
      "coordinator.spawn_run",
      {
        authToken: "generation-secret",
        runId: "run-1",
        sessionId: "session-1",
        prompt: "hello",
        runtime: expectedRuntime,
      },
      expect.any(Number),
    );
    const wireParams = call.mock.calls[0]?.[1];
    expect(wireParams).not.toHaveProperty("credentials");
    expect(wireParams).not.toHaveProperty("traceId");
    expect(wireParams).not.toHaveProperty("sourcePath");
    expect(wireParams).not.toHaveProperty("database");
    expect(wireParams).not.toHaveProperty("modelFallback");
    expect(JSON.stringify(wireParams)).not.toContain("must-not-cross-the-port");
  });

  test("rejects a runtime forged for another worker identity", async () => {
    const runtimeDefinition = mock(async () => workerRuntime({ workerId: "forged-worker" }));
    const { call, supervisor } = deliverySupervisor(runtimeDefinition);

    await expect(
      supervisor.deliver("run-1", { sessionId: "session-1", prompt: "hello" }),
    ).rejects.toThrow("runtime definition identity does not match worker process binding");
    expect(call).not.toHaveBeenCalled();
  });

  test("prevents delivery when the required runtime definition port is missing", async () => {
    const { call, supervisor } = deliverySupervisor();

    await expect(
      supervisor.deliver("run-1", { sessionId: "session-1", prompt: "hello" }),
    ).rejects.toThrow("worker runtime definition port is required");
    expect(call).not.toHaveBeenCalled();
  });

  test("rejects credential material added outside the strict runtime contract", async () => {
    const runtimeDefinition = mock(async () => ({
      ...workerRuntime(),
      credentials: { apiKey: "secret" },
      sourcePath: "/owner/home/.config/provider",
      database: { url: "secret" },
    }));
    const { call, supervisor } = deliverySupervisor(runtimeDefinition as never);

    await expect(
      supervisor.deliver("run-1", { sessionId: "session-1", prompt: "hello" }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("worker supervisor bootstrap authentication", () => {
  test("requires exact generation proofs around the bootstrap response", () => {
    const challenge = createWorkerBootstrapChallenge();
    const binding = { runtimeId: "runtime-1", workerId: "7", generation: 3 };
    const proof = workerBootstrapProof("generation-secret", challenge, "request", binding);

    expect(isBootstrapAccepted({ ok: true })).toBe(true);
    expect(isBootstrapAccepted({ ok: false })).toBe(false);
    expect(isWorkerBootstrapProof(proof, proof)).toBe(true);
    expect(
      isWorkerBootstrapProof(
        workerBootstrapProof("generation-secret", challenge, "ready", binding),
        proof,
      ),
    ).toBe(false);
    expect(
      isWorkerBootstrapProof(
        workerBootstrapProof("generation-secret", challenge, "request", {
          ...binding,
          generation: 2,
        }),
        proof,
      ),
    ).toBe(false);
  });

  test("denies every RPC while the installed client is not bootstrap-ready", async () => {
    const { call, supervisor } = deliverySupervisor(async () => workerRuntime());
    Object.assign(supervisor, { bootstrapped: false });

    await expect(
      supervisor.deliver("run-1", { sessionId: "session-1", prompt: "hello" }),
    ).rejects.toThrow("worker 7 not available");
    expect(await supervisor.cancel("run-1", "session-1")).toEqual({
      cancelled: false,
      error: "worker 7 not available",
    });
    expect(await supervisor.send("session-1", "hello")).toEqual({
      accepted: false,
      error: "worker 7 not available",
    });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("worker supervisor connection binding", () => {
  test("ignores a stale client's late ready and publishes only the authenticated active connection", async () => {
    process.env.OPENOMNI_WORKER_FIRST_READY_DELAY_MS = "1250";
    const events: string[] = [];
    const supervisor = liveSupervisor(events);
    const supervisorDir = path.dirname(supervisor.socketPath);
    try {
      await supervisor.waitReady(8_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      expect(supervisor.isReady()).toBe(true);
      expect(fs.statSync(supervisorDir).mode & 0o777).toBe(0o700);
      expect(events.filter((event) => event.includes("ready"))).toHaveLength(1);
      expect(supervisor.getGeneration()).toBe(1);
    } finally {
      delete process.env.OPENOMNI_WORKER_FIRST_READY_DELAY_MS;
      await supervisor.stop();
    }
    expect(fs.existsSync(supervisorDir)).toBe(false);
  }, 12_000);

  test("closes rejected bootstrap clients and succeeds on a later authenticated retry", async () => {
    process.env.OPENOMNI_WORKER_BOOTSTRAP_REJECTS = "2";
    const supervisor = liveSupervisor();
    try {
      await supervisor.waitReady(8_000);
      expect(supervisor.isReady()).toBe(true);
    } finally {
      delete process.env.OPENOMNI_WORKER_BOOTSTRAP_REJECTS;
      await supervisor.stop();
    }
  }, 12_000);

  test("rejects a substituted stale socket and rotates to a new generation capability", async () => {
    const supervisor = liveSupervisor();
    const supervisorDir = path.dirname(supervisor.socketPath);
    try {
      await supervisor.waitReady(8_000);
      const stalePath = supervisor.socketPath;
      const firstGeneration = supervisor.getGeneration();
      supervisor.forceKill();
      const unlinkDeadline = Date.now() + 3_000;
      while (fs.existsSync(stalePath) && Date.now() < unlinkDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(stalePath)).toBe(false);
      fs.writeFileSync(stalePath, "substituted stale endpoint", { mode: 0o600 });

      const restartDeadline = Date.now() + 8_000;
      while (
        (supervisor.getGeneration() === firstGeneration || !supervisor.isReady()) &&
        Date.now() < restartDeadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      expect(supervisor.getGeneration()).toBe(firstGeneration + 1);
      expect(supervisor.socketPath).not.toBe(stalePath);
      expect(supervisor.isReady()).toBe(true);
      expect(fs.existsSync(stalePath)).toBe(true);
    } finally {
      await supervisor.stop();
    }
    expect(fs.existsSync(supervisorDir)).toBe(false);
  }, 15_000);
});
