import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Provider } from "@openomni/llm";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import { createWorkspaceIdentity, toWorkspaceRef } from "@openomni/openomni";
import { Execution, Ipc, WorkerDriver } from "@openomni/protocol";
import { createWorkerManager, type WorkerManager, type WorkerPorts } from "@openomni/coordinator";
import {
  createP2WorkerTransferCredentialRef,
  encodeP2PrivateProvisioningFrame,
  p2ProvisioningAuthenticationTag,
  p2ProvisioningBytes,
  type ProvisionedCredentialMaterial,
} from "../../src/execution/p2-worker-provisioning";
import { createPinnedWorkerModelCatalog } from "../../src/execution/worker-runtime";

const WORKER_ENTRY = fileURLToPath(new URL("../../src/execution/worker-entry.ts", import.meta.url));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secretCanary = "full-stack/private+provider=secret";
const encodedSecretCanary = encodeURIComponent(secretCanary);
const runtimeId = "full-stack-runtime";
const principalId = "full-stack-principal";
const configEpoch = "full-stack-config-v1";
const modelRef = { provider: "openai", id: "deterministic-worker-model" } as const;
const attempt = {
  version: "attempt-ref-v1" as const,
  workItemId: "full-stack-work",
  attemptId: "full-stack-attempt",
  attemptSeq: 1,
};

type CollectedEvent = { event: { name: string }; data: unknown };

let manager: WorkerManager | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let socketDir: string | undefined;

function canonicalize(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(canonical(value));
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("full-stack worker condition was not met before timeout");
}

function generationEvents(events: CollectedEvent[], name: string): number[] {
  return events
    .filter((entry) => entry.event.name === name)
    .map((entry) => (entry.data as { generation: number }).generation);
}

afterEach(async () => {
  await manager?.shutdown();
  manager = undefined;
  provider?.stop(true);
  provider = undefined;
  if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
  socketDir = undefined;
});

describe("production worker process full stack", () => {
  test("crosses supervisor IPC, provisions privately, settles once, restarts, and fails closed on identity and claim mismatch", async () => {
    const providerRequests: Array<{ authorization: string | null; body: string }> = [];
    provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        providerRequests.push({
          authorization: request.headers.get("authorization"),
          body: await request.text(),
        });
        const chunks = [
          {
            id: "chatcmpl-full-stack",
            object: "chat.completion.chunk",
            created: 1,
            model: modelRef.id,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "deterministic worker result" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-full-stack",
            object: "chat.completion.chunk",
            created: 1,
            model: modelRef.id,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
          },
        ];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    const baseURL = `http://127.0.0.1:${provider.port}/v1`;
    const sanitizer = BoundarySanitizer.create();
    const secrets = SecretRegistry.create(sanitizer);
    const owner = secrets.register(
      CredentialSource.parseOwner({
        providerId: modelRef.provider,
        credentialId: "full-stack-owner",
        rotationId: "full-stack-rotation",
        sourceKind: "injected_runtime",
        auth: { type: "proxy", baseURL, apiKey: secretCanary },
      }),
    );
    const material: ProvisionedCredentialMaterial = {
      providerId: modelRef.provider,
      credentialId: owner.ref.credentialId,
      authType: "proxy",
      baseURL,
      secret: p2ProvisioningBytes(secretCanary),
    };
    const events: CollectedEvent[] = [];
    const acknowledgements: Ipc.CredentialProvisioningAcknowledgementV1[] = [];
    const identityMismatchRuns = new Set(["run-identity-mismatch"]);
    const claimMismatchRuns = new Set(["run-claim-mismatch"]);
    const runtimeByRun = new Map<string, Ipc.WorkerRuntimeDefinitionV1>();
    const workspace = toWorkspaceRef(createWorkspaceIdentity(process.cwd()));

    const runtimeDefinition: WorkerPorts["runtimeDefinition"] = async (binding, task) => {
      const credential = createP2WorkerTransferCredentialRef({
        ownerRef: owner.ref,
        peerIdentity: binding,
        attempt,
        credential: {
          providerId: material.providerId,
          authType: "proxy",
          baseURL,
          ...(material.secret === undefined ? {} : { apiKey: material.secret.slice() }),
        },
      });
      const provisionalEnvironment = {
        version: "llm-environment-v1" as const,
        catalogSchemaVersion: 1,
        catalogSource: "bundled" as const,
        catalogSourceVersion: "full-stack-test",
        catalogDigest: digest("full-stack-catalog"),
        modelDigest: digest("provisional-model"),
        endpoint: {
          version: "llm-endpoint-ref-v1" as const,
          kind: "proxy" as const,
          valueRef: credential.endpointRef ?? `proxy:${baseURL}`,
          endpointDigest: digest(baseURL),
        },
        credential,
        sdkPackage: "@ai-sdk/openai",
        adapterVersion: "full-stack-test",
        environmentDigest: digest("provisional-environment"),
      };
      const [model] = await Provider.listModels(
        createPinnedWorkerModelCatalog({ model: modelRef, environment: provisionalEnvironment }),
        modelRef.provider,
      );
      if (!model) throw new Error("pinned full-stack model is missing");
      const { environmentDigest: _provisionalDigest, ...provisionalBase } = provisionalEnvironment;
      const environmentBase = {
        ...provisionalBase,
        modelDigest: digest(canonicalize(model)),
      };
      const environment = {
        ...environmentBase,
        environmentDigest: digest(canonicalize(environmentBase)),
      };
      const agent = {
        name: "full-stack-agent",
        description: "deterministic full-process test agent",
        model: modelRef,
        systemPrompt: "Return the deterministic provider response.",
        tools: { allow: [] },
        budget: { maxTurns: 1, maxWallTimeMs: 5_000 },
      };
      const runtime = Ipc.WorkerRuntimeDefinitionV1.parse({
        runtimeId: binding.runtimeId,
        workerId: binding.workerId,
        generation: binding.generation,
        principalId: binding.principalId,
        attempt,
        config: {
          configEpoch,
          model: modelRef,
          environment,
          workspace,
          agents: [agent],
          toolCatalog: [],
          budget: agent.budget,
        },
      });
      runtimeByRun.set(task.runId, runtime);
      return runtime;
    };

    const ports: WorkerPorts = {
      events: {
        publish(event, data) {
          events.push({ event, data });
        },
      },
      runtimeDefinition,
      kernelTransition: async () => ({
        version: "kernel-transition-result-v1",
        status: "rejected",
        code: "transition_forbidden",
      }),
      kernelQuery: async ({ request }) => {
        const runtime = runtimeByRun.get(request.runId);
        if (!runtime) throw new Error("missing authenticated runtime in full-stack query");
        if (request.request.kind === "authenticated_attempt") {
          return {
            version: "kernel-query-result-v1",
            kind: "authenticated_attempt",
            attempt: claimMismatchRuns.has(request.runId)
              ? { ...runtime.attempt, attemptId: "substituted-attempt" }
              : runtime.attempt,
            events: [],
          };
        }
        return {
          version: "kernel-query-result-v1",
          kind: "authenticated_transcript",
          messages: [],
        };
      },
      observation: async () => undefined,
      provisionCredentials: async (frame, signer) => {
        if (!signer) throw new Error("missing private generation signer");
        const request = Execution.CredentialProvisioningRequestV1.parse(frame.request);
        const peerIdentity = {
          runtimeId: frame.channelIdentity.runtimeId,
          workerId: frame.channelIdentity.workerId,
          generation: frame.channelIdentity.generation,
          principalId: frame.channelIdentity.principalId,
          processId: identityMismatchRuns.has(frame.channelIdentity.runId)
            ? frame.channelIdentity.processId + 1
            : frame.channelIdentity.processId,
        };
        const transferred = [
          {
            ...material,
            ...(material.secret === undefined ? {} : { secret: material.secret.slice() }),
          },
        ];
        const authenticationTag = identityMismatchRuns.has(frame.channelIdentity.runId)
          ? new Uint8Array(32)
          : p2ProvisioningAuthenticationTag(signer, request, peerIdentity, transferred);
        const privateFrame = encodeP2PrivateProvisioningFrame({
          peerIdentity,
          authenticationTag,
          credentials: transferred,
        });
        authenticationTag.fill(0);
        transferred.forEach((credential) => {
          credential.secret?.fill(0);
        });
        const receipt = Execution.CredentialProvisioningReceiptV1.parse({
          version: "credential-provisioning-receipt-v1",
          runtimeId: request.runtimeId,
          workerId: request.workerId,
          generation: request.generation,
          principalId: request.principalId,
          attempt: request.attempt,
          nonceRef: request.nonceRef,
          acceptedCredentialDigests: request.credentialRefs.map(
            (credential) => credential.credentialDigest,
          ),
          acceptedAtDbMs: Date.now(),
        });
        return {
          privateFrame,
          receipt,
          acknowledge: async (acknowledgement) => {
            acknowledgements.push(acknowledgement);
          },
        };
      },
    };

    socketDir = fs.mkdtempSync("/tmp/openomni-worker-full-stack-");
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        runtimeId,
        principalId,
        bootstrap: { configEpoch },
        socketDir,
        maxActiveWorkers: 1,
        idleShutdownMs: 60_000,
      },
      ports,
    );

    const success = await manager.deliver("run-success", {
      sessionId: "session-full-stack",
      prompt: "execute through the real worker process",
      agentName: "full-stack-agent",
    });
    expect(success).toMatchObject({
      runId: "run-success",
      sessionId: "session-full-stack",
      status: "succeeded",
      output: "deterministic worker result",
      workerId: "0",
    });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.authorization).toBe(`Bearer ${secretCanary}`);
    expect(providerRequests[0]?.body).toContain("execute through the real worker process");
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]).toMatchObject({
      workerId: "0",
      runId: "run-success",
      sessionId: "session-full-stack",
    });
    const settled = events.find(
      (entry) =>
        entry.event.name === WorkerDriver.RunSettled.name &&
        (entry.data as { runId?: string }).runId === "run-success",
    )?.data;
    expect(settled).toMatchObject({
      runId: "run-success",
      sessionId: "session-full-stack",
      outcome: "completed",
    });

    await waitFor(() => generationEvents(events, WorkerDriver.Exited.name).includes(1));
    await waitFor(() => generationEvents(events, WorkerDriver.Ready.name).includes(2));
    expect(
      events.find((entry) => entry.event.name === WorkerDriver.Restarted.name)?.data,
    ).toMatchObject({ restartCount: 1 });

    const identityMismatch = await manager.deliver("run-identity-mismatch", {
      sessionId: "session-full-stack",
      prompt: "identity mismatch must fail closed",
      agentName: "full-stack-agent",
    });
    expect(identityMismatch).toMatchObject({
      status: "failed",
      error: "credential provisioning denied",
    });
    expect(acknowledgements).toHaveLength(1);
    expect(providerRequests).toHaveLength(1);

    await waitFor(() => generationEvents(events, WorkerDriver.Ready.name).includes(3), 12_000);
    const claimMismatch = await manager.deliver("run-claim-mismatch", {
      sessionId: "session-full-stack",
      prompt: "claim mismatch must fail closed",
      agentName: "full-stack-agent",
    });
    expect(claimMismatch).toMatchObject({
      status: "failed",
      error: "run attempt does not match the authenticated runtime",
    });
    expect(acknowledgements).toHaveLength(2);
    expect(providerRequests).toHaveLength(1);

    const publicEvidence = JSON.stringify({
      events,
      runtimes: [...runtimeByRun.values()],
      acknowledgements,
      argv: process.argv,
      env: process.env,
    });
    expect(publicEvidence).not.toContain(secretCanary);
    expect(JSON.stringify(success)).not.toContain(secretCanary);
    expect(publicEvidence).not.toContain(encodedSecretCanary);
    expect(JSON.stringify(success)).not.toContain(encodedSecretCanary);
    material.secret?.fill(0);
    secrets.dispose();
    sanitizer.dispose();
  }, 30_000);
});
