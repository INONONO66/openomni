import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Execution, Ipc, type Sink } from "@openomni/protocol";
import { Provider, run } from "@openomni/llm";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import { openP2ProductionRuntime } from "../../src/bootstrap/p2-runtime";
import { createIncidentSink } from "../../src/server/incidents";
import {
  createAuthorityServices,
  createDefaultDispatchRuntime,
  createProductionSnapshotBlob,
  IngressEngine,
} from "@openomni/openomni";
import { createProductionComposition } from "../../src/bootstrap/kernel-services";
import { DiscordNormalizer } from "../../src/channel/discord/normalizer";
import { createMessageHandler } from "../../src/handler/conversation";
import { createWorkerGenerationKeySigner } from "../../../../packages/coordinator/src/worker-supervision/supervisor-process";
import { runRecovery } from "../../src/bootstrap/recovery";
import { resolveRuntimeModel } from "../../src/agents/model-resolution";

const digest = "a".repeat(64);
const roots: string[] = [];
const runtimes: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  IngressEngine.reset();
});

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function withReceiptHash(receipt: Record<string, unknown>): Record<string, unknown> {
  const { receiptHash: _receiptHash, ...withoutHash } = receipt;
  return {
    ...withoutHash,
    receiptHash: createHash("sha256").update(canonicalJson(withoutHash)).digest("hex"),
  };
}

function workerSemanticRequest(
  target: Record<string, unknown>,
  transitionId: string,
  requestId: string,
  content?: unknown,
  effectBinding?: unknown,
  evidenceRef?: string,
) {
  const immutableTarget = {
    owner: target.owner,
    workItemId: target.workItemId,
    runId: target.runId,
    attempt: target.attempt,
  };
  const requestHash = createHash("sha256")
    .update(
      canonicalJson({
        transitionId,
        target: immutableTarget,
        evidenceRef,
        content,
        effectBinding,
      }),
    )
    .digest("hex");
  return {
    transitionId,
    requestId,
    requestHash,
    target,
    ...(content === undefined ? {} : { content }),
    ...(effectBinding === undefined ? {} : { effectBinding }),
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
  };
}

function environment() {
  const credential = {
    version: "credential-source-ref-v1" as const,
    providerId: "openai",
    authType: "api" as const,
    credentialId: "owner-default",
    rotationId: "rotation-1",
    sourceKind: "override_file" as const,
    sourcePathDigest: digest,
    credentialDigest: digest,
  };
  return {
    version: "llm-environment-v1" as const,
    catalogSchemaVersion: 1,
    catalogSource: "bundled" as const,
    catalogSourceVersion: "test",
    catalogDigest: digest,
    modelDigest: digest,
    endpoint: {
      version: "llm-endpoint-ref-v1" as const,
      kind: "default" as const,
      valueRef: "provider-default",
      endpointDigest: digest,
    },
    credential,
    sdkPackage: "@ai-sdk/openai",
    adapterVersion: "1",
    environmentDigest: digest,
  };
}

describe("P2 production one-writer composition", () => {
  test("server composition contains wiring, not product lifecycle semantics", () => {
    const source = readFileSync(
      new URL("../../src/bootstrap/kernel-services.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createProductionKernelServices");
    for (const forbidden of [
      "createWaitServices",
      "selectChannelGrant",
      "transitionAttempt",
      "createEffectServices",
      "createRecoveryServices",
      "createWorkerLedger",
      "completionSnapshotRef",
      "quorum",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
  test("authority resolves exact channel and surface grants without synthesizing channel IDs", async () => {
    const source = {
      sourceEventId: "authority-event-1",
      sourceOwnerSeq: 1,
      sourceLedgerSeq: 10,
      sourceOwnerHash: "authority-hash-1",
      asOfLedgerSeq: 10,
    };
    const channelGrant = {
      ...source,
      grantId: "grant-ops",
      state: {
        grant: {
          id: "grant-ops",
          surface: "discord",
          channel: "ops",
          kind: "trusted_channel",
          createdBy: "owner",
        },
      },
    };
    const surfaceGrant = {
      ...source,
      grantId: "grant-websocket",
      state: {
        grant: {
          id: "grant-websocket",
          surface: "websocket",
          kind: "trusted_channel",
          createdBy: "owner",
        },
      },
    };
    let selectedChannelGrant: typeof channelGrant | typeof surfaceGrant | undefined;
    const query = {
      actorEndpoint: () => undefined,
      actorIdentity: () => undefined,
      workerAttemptGrants: () => [],
      blacklistEntries: () => [],
      channelGrant: (channel: string) => {
        selectedChannelGrant =
          channel === "ops" ? channelGrant : channel === "websocket" ? surfaceGrant : undefined;
        return selectedChannelGrant;
      },
      attemptByRunId: () => undefined,
    };
    const authority = createAuthorityServices(query);

    await expect(
      authority.query({ kind: "authority.channel_grant", surface: "discord", channel: "ops" }),
    ).resolves.toMatchObject({ grant: { id: "grant-ops", channel: "ops" } });
    await expect(
      authority.query({ kind: "authority.channel_grant", surface: "websocket" }),
    ).resolves.toMatchObject({ grant: { id: "grant-websocket", surface: "websocket" } });
    await expect(
      authority.query({ kind: "authority.channel_grant", surface: "discord", channel: "forged" }),
    ).resolves.toMatchObject({ grant: null });

    selectedChannelGrant = {
      ...channelGrant,
      grantId: "projection-id",
      state: { grant: { ...channelGrant.state.grant, id: "embedded-id" } },
    };
    query.channelGrant = () => selectedChannelGrant;
    await expect(
      authority.query({ kind: "authority.channel_grant", surface: "discord", channel: "ops" }),
    ).resolves.toMatchObject({ grant: null });

    selectedChannelGrant = {
      ...channelGrant,
      state: { ...channelGrant.state.grant, grant: channelGrant.state.grant },
    };
    await expect(
      authority.query({ kind: "authority.channel_grant", surface: "discord", channel: "ops" }),
    ).resolves.toMatchObject({ grant: null });
  });

  test("actor authority requires exact endpoint and identity bindings with both provenances", async () => {
    const endpointSource = {
      sourceEventId: "endpoint-event",
      sourceOwnerSeq: 2,
      sourceLedgerSeq: 12,
      sourceOwnerHash: "endpoint-hash",
      asOfLedgerSeq: 12,
    };
    const identitySource = {
      sourceEventId: "identity-event",
      sourceOwnerSeq: 3,
      sourceLedgerSeq: 13,
      sourceOwnerHash: "identity-hash",
      asOfLedgerSeq: 13,
    };
    let endpointRow = {
      ...endpointSource,
      ownerKey: "endpoint:discord:user-1",
      endpointId: "discord:user-1",
      actorId: "actor-1",
      state: {
        endpoint: {
          id: "discord:user-1",
          actorId: "actor-1",
          channel: "discord",
          externalId: "user-1",
        },
      },
    };
    let identityRow = {
      ...identitySource,
      ownerKey: "actor:actor-1",
      actorId: "actor-1",
      state: {
        identity: {
          id: "actor-1",
          kind: "human",
          trustTier: "owner",
          relationship: "owner",
        },
      },
    };
    const authority = createAuthorityServices({
      actorEndpoint: () => endpointRow,
      actorIdentity: () => identityRow,
      workerAttemptGrants: () => [],
      blacklistEntries: () => [],
      channelGrant: () => undefined,
      attemptByRunId: () => undefined,
    });
    const request = {
      kind: "authority.actor_by_endpoint",
      surface: "discord",
      externalId: "user-1",
    } as const;

    await expect(authority.query(request)).resolves.toMatchObject({
      endpoint: { id: "discord:user-1", actorId: "actor-1" },
      identity: { id: "actor-1" },
      endpointSourceRefs: endpointSource,
      identitySourceRefs: identitySource,
    });

    endpointRow = { ...endpointRow, actorId: "actor-forged" };
    await expect(authority.query(request)).resolves.toMatchObject({
      endpoint: null,
      identity: null,
    });

    endpointRow = { ...endpointRow, actorId: "actor-1" };
    identityRow = { ...identityRow, sourceEventId: "" };
    await expect(authority.query(request)).resolves.toMatchObject({
      endpoint: null,
      identity: null,
      identitySourceRefs: null,
    });
  });

  test("worker grant authority binds only one active grant to the projected Attempt generation", async () => {
    const source = {
      sourceEventId: "grant-event-1",
      sourceOwnerSeq: 1,
      sourceLedgerSeq: 20,
      sourceOwnerHash: "grant-hash-1",
      asOfLedgerSeq: 20,
    };
    const attempt = {
      version: "attempt-ref-v1" as const,
      workItemId: "work-current",
      attemptId: "attempt-current",
      attemptSeq: 2,
    };
    const attemptRow = {
      ...source,
      workItemId: attempt.workItemId,
      attemptId: attempt.attemptId,
      sessionId: "session-worker",
      state: {
        ...attempt,
        sessionId: "session-worker",
        runId: "run-worker",
        status: "running",
      },
    };
    const grantRow = (boundAttempt: typeof attempt, id = "grant-worker") => ({
      ...source,
      grantId: id,
      workItemId: boundAttempt.workItemId,
      attemptId: boundAttempt.attemptId,
      state: {
        id,
        attempt: boundAttempt,
        status: "active",
        version: 1,
        allowedActions: ["worker.send"],
        canCreateExternalTasks: false,
      },
    });
    let grants = [grantRow(attempt)];
    const query = {
      actorEndpoint: () => undefined,
      actorIdentity: () => undefined,
      blacklistEntries: () => [],
      channelGrant: () => undefined,
      attemptByRunId: (runId: string) => (runId === "run-worker" ? attemptRow : undefined),
      workerAttemptGrants: () => grants,
    };
    const authority = createAuthorityServices(query);
    const request = {
      kind: "authority.worker_grant",
      target: { sessionId: "session-worker", runId: "run-worker" },
    };

    const valid = await authority.query(request);
    expect(valid).toMatchObject({ grant: { id: "grant-worker", attempt } });
    expect(JSON.stringify(valid)).not.toContain("workerRunId");

    grants = [grantRow({ ...attempt, attemptSeq: 1 })];
    await expect(authority.query(request)).resolves.toMatchObject({ grant: null });

    grants = [grantRow(attempt), grantRow(attempt, "grant-duplicate")];
    await expect(authority.query(request)).resolves.toMatchObject({ grant: null });

    grants = [{ ...grantRow(attempt), grantId: "projection-id" }];
    await expect(authority.query(request)).resolves.toMatchObject({ grant: null });

    const canonical = grantRow(attempt);
    grants = [
      {
        ...canonical,
        state: { ...canonical.state, grant: { ...canonical.state, id: "nested-forged" } },
      },
    ];
    await expect(authority.query(request)).resolves.toMatchObject({ grant: null });

    const { id: _missingId, ...missingIdState } = canonical.state;
    grants = [{ ...canonical, state: missingIdState }];
    await expect(authority.query(request)).resolves.toMatchObject({ grant: null });
    await expect(
      authority.query({
        ...request,
        target: { sessionId: "session-forged", runId: "run-worker" },
      }),
    ).resolves.toMatchObject({ grant: null });
  });
  test("missing Owner credentials fail before catalog or SQLite side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "openomni-one-writer-preflight-"));
    roots.push(root);
    const authPath = join(root, "auth.json");
    await Bun.write(authPath, "{}\n");
    const dbPath = join(root, "storage", "ledger.db");
    let catalogLoads = 0;

    await expect(
      openP2ProductionRuntime({
        dbPath,
        credentialPath: authPath,
        createIncidentSink: () => ({ report: () => undefined }),
        modelCatalog: {
          async load() {
            catalogLoads += 1;
            return { catalog: {}, environment: environment(), fallbackDiagnostics: [] };
          },
          async get() {
            return {};
          },
        },
        createKernel() {
          throw new Error("must not compose without Owner credentials");
        },
      }),
    ).rejects.toThrow("requires an Owner credential");
    expect(catalogLoads).toBe(0);
    expect(existsSync(join(root, "storage"))).toBe(false);
  });
  test("production snapshots are canonical content-addressed bytes", () => {
    const first = createProductionSnapshotBlob({ b: [2, 1], a: "value" });
    const second = createProductionSnapshotBlob({ a: "value", b: [2, 1] });

    expect(first.ref).toEqual(second.ref);
    expect(first.ref.byteLength).toBe(first.bytes.byteLength);
    expect(first.ref.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(first.bytes)).toBe('{"a":"value","b":[2,1]}');
  });
  test("incident data is redacted and explicitly non-authoritative", () => {
    const sanitizer = BoundarySanitizer.create();
    const registry = SecretRegistry.create(sanitizer);
    registry.register(
      CredentialSource.parseOwner({
        providerId: "openai",
        credentialId: "incident-test",
        rotationId: "rotation-1",
        sourceKind: "injected_runtime",
        auth: { type: "api", key: "incident-secret-canary" },
      }),
    );
    const incidents: unknown[] = [];
    const sink = createIncidentSink({ sanitizer, publish: (incident) => incidents.push(incident) });
    sink.report({
      component: "provider",
      summary: "failed incident-secret-canary",
      data: { authoritative: true, token: "incident-secret-canary" },
    });
    expect(JSON.stringify(incidents)).not.toContain("incident-secret-canary");
    expect(incidents).toEqual([expect.objectContaining({ authoritative: false })]);
    sink.dispose();
    registry.dispose();
  });
  test("bootstrap recovery fails closed when an authoritative reconciliation fails", async () => {
    await expect(
      runRecovery({
        runs: {
          queries: { interruptedRuns: async () => [] },
          commands: { interruptRun: async () => "unchanged" as const },
        },
        messages: {
          queries: {
            interruptedMessages: async () => [
              { sessionId: "session-recovery", messageId: "message-recovery" },
            ],
          },
          commands: {
            reconcileInterruptedMessage: async () => {
              throw new Error("authoritative recovery unavailable");
            },
          },
        },
      }),
    ).rejects.toThrow("authoritative recovery unavailable");
  });

  test("production composition commits and reads a semantic session through the owned runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "openomni-production-composition-"));
    roots.push(root);
    const authPath = join(root, "auth.json");
    await Bun.write(
      authPath,
      `${JSON.stringify({
        anthropic: {
          providerId: "anthropic",
          credentialId: "owner-default",
          rotationId: "rotation-1",
          sourceKind: "override_file",
          sourcePath: authPath,
          auth: { type: "api", key: "test-owner-secret" },
        },
      })}\n`,
    );
    const previousAuthFile = process.env.OPENOMNI_AUTH_FILE;
    process.env.OPENOMNI_AUTH_FILE = authPath;
    try {
      const composition = createProductionComposition({
        workspace: { root },
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        mcp: { servers: [] },
        server: { port: 0, host: "127.0.0.1" },
        storage: { dbPath: join(root, "unused.db") },
        telegram: { allowedUsers: [] },
        github: { allowedUsers: [] },
        discord: { allowedUsers: [] },
      });
      const runtimePath = join(root, "production.db");
      let runtime = await composition.openRuntime(runtimePath);
      runtimes.push(runtime);
      expect(Object.keys(runtime.services.connectorCredentials)).toEqual(["owner-default"]);
      expect(
        Object.keys(runtime.services).some((key) => key.toLowerCase().includes("verifier")),
      ).toBe(false);
      expect(runtime.services.connectorCredentials["owner-default"]).toBe(
        runtime.services.modelCredential,
      );
      const [productionModel] = await Provider.listModels(runtime.modelCatalog, "anthropic");
      if (productionModel === undefined) throw new Error("production model is missing");
      expect(productionModel.id).toBe("claude-opus-4-5");
      expect(runtime.modelEnvironment.modelDigest).toBe(Provider.modelDigest(productionModel));
      const { environmentDigest, ...environmentBase } = runtime.modelEnvironment;
      expect(environmentDigest).toBe(
        createHash("sha256").update(canonicalJson(environmentBase)).digest("hex"),
      );
      expect(Object.isFrozen(runtime.modelEnvironment)).toBe(true);
      expect(Object.isFrozen(runtime.modelEnvironment.credential)).toBe(true);
      await expect(
        resolveRuntimeModel({
          model: { provider: "anthropic", id: "claude-opus-4-5" },
          modelCatalog: runtime.modelCatalog,
          secretRegistry: runtime.secrets,
          credentialHandle: runtime.services.modelCredential,
          modelEnvironment: runtime.modelEnvironment,
        }),
      ).resolves.toMatchObject({
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        environment: runtime.modelEnvironment,
      });
      await expect(
        run(
          {
            messages: [],
            tools: [],
            model: { ...productionModel, name: `${productionModel.name} mutated` },
            environment: {
              reference: runtime.modelEnvironment,
              credential: runtime.services.modelCredential,
              secrets: runtime.secrets,
              sanitizer: runtime.sanitizer,
            },
          },
          {} as Sink,
        ),
      ).rejects.toThrow("LLM environment model digest does not match the selected model");
      const runtimeDefinitionBootstrap: Parameters<
        typeof runtime.services.createWorkerRuntimeDefinition
      >[0] = {
        configEpoch: "runtime-config-1",
        agents: [
          {
            name: "dev",
            description: "test worker",
            model: { provider: "anthropic", id: "claude-opus-4-5" },
            systemPrompt: "test",
            tools: { categories: ["filesystem"] },
            budget: { maxTurns: 3, maxToolCalls: 5 },
          },
        ],
        toolCatalog: [],
      };
      let definitionPort = runtime.services.createWorkerRuntimeDefinition(
        runtimeDefinitionBootstrap,
      );
      const closeOwnedRuntime = async () => {
        const closing = runtime;
        await closing.close();
        const index = runtimes.indexOf(closing);
        if (index >= 0) runtimes.splice(index, 1);
      };
      const reopenOwnedRuntime = async () => {
        runtime = await composition.openRuntime(runtimePath);
        runtimes.push(runtime);
        definitionPort = runtime.services.createWorkerRuntimeDefinition(runtimeDefinitionBootstrap);
      };
      const allocateCommittedAttempt = async (input: {
        sessionId: string;
        runId: string;
        title: string;
        prompt: string;
        agentName: string;
        parentSessionId?: string;
      }) => {
        const requestId = `${input.runId}:allocate`;
        const workItemId = `work-${createHash("sha256")
          .update(requestId)
          .digest("hex")
          .slice(0, 32)}`;
        const target = {
          owner: { version: "ledger-owner-v1" as const, ownerKey: `work:${workItemId}` },
          workItemId,
          runId: input.runId,
          attempt: {
            version: "attempt-ref-v1" as const,
            workItemId,
            attemptId: input.runId,
            attemptSeq: 1,
          },
          status: "draft" as const,
          evidenceRefs: [],
          readbackRefs: [],
        };
        const allocation = await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(target, "DP-05", requestId, {
            name: input.title,
            sourceMessageId: requestId,
            sourceChannel: "dispatch",
            intent: "worker.spawn",
            goal: input.prompt,
            assigneeId: input.agentName,
            sessionId: input.sessionId,
            originSessionId: input.parentSessionId,
            executorKind: "internal_chat_agent",
            acceptanceCriteria: [`Complete ${input.title}`],
          }),
        );
        expect(allocation.transitionResult).toMatchObject({ status: "committed" });
        const attempt = await runtime.services.workerAttempts.queries.byExecution({
          sessionId: input.sessionId,
          runId: input.runId,
        });
        if (!attempt) throw new Error(`Committed Attempt projection missing for ${input.runId}`);
        return attempt;
      };
      const command = {
        kind: "SS-01" as const,
        sessionId: "session-production",
        title: "Production session",
        model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        openedAt: 1,
      };
      await runtime.services.messagingLedger.execute(command);
      expect(
        await runtime.services.messagingLedger.query({
          kind: "session",
          sessionId: command.sessionId,
        }),
      ).toMatchObject({
        kind: "session",
        session: { id: command.sessionId, title: command.title },
      });
      await runtime.services.messagingLedger.execute({
        kind: "MS-01",
        sessionId: command.sessionId,
        event: {
          id: "inbound-production-1",
          surface: "internal",
          mode: "internal",
          agentName: "resident",
          payload: "hello",
          target: { kind: "resident" },
          meta: { actor: { role: "owner", id: "owner" } },
          agent: { name: "resident", model: command.model, systemPrompt: "resident", tools: [] },
        },
        messageId: "message-production-1",
        partId: "part-production-1",
        text: "hello",
        model: command.model,
        recordedAt: 2,
      });
      expect(
        await runtime.services.messagingLedger.query({
          kind: "transcript",
          sessionId: command.sessionId,
        }),
      ).toEqual({
        kind: "transcript",
        messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      });
      const hostileArtifactInput = {
        ownerSessionId: command.sessionId,
        artifactId: "artifact-production-1",
        content: new TextEncoder().encode("authoritative artifact"),
        mediaType: "text/plain",
        title: "Production artifact",
        configurationSnapshotRef: createProductionSnapshotBlob({ forged: true }).ref,
      };
      await runtime.services.connectorArtifacts.putAndReference(hostileArtifactInput);
      const transcriptEvents = await runtime.queries.query({
        version: "kernel-query-v1",
        kind: "authenticated_transcript",
        identity: {
          version: "authenticated-worker-identity-v1",
          runtimeId: "test-runtime",
          workerId: "test-worker",
          generation: 1,
          principalId: "server",
          sessionId: command.sessionId,
          runId: "resident-run",
          attemptId: "resident-attempt",
        },
        sessionId: command.sessionId,
      });
      expect(transcriptEvents).toEqual({
        version: "kernel-query-result-v1",
        kind: "authenticated_transcript",
        messages: [{ role: "user", content: "hello" }],
      });
      const attemptState = await allocateCommittedAttempt({
        sessionId: "session-runtime",
        runId: "run-runtime",
        title: "runtime work",
        prompt: "runtime prompt",
        agentName: "dev",
      });
      const attemptEvents = await runtime.queries.query({
        version: "kernel-query-v1",
        kind: "authenticated_attempt",
        identity: {
          version: "authenticated-worker-identity-v1",
          runtimeId: "test-runtime",
          workerId: "test-worker",
          generation: 1,
          principalId: "server",
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
          attemptId: attemptState.attemptId,
        },
        attempt: {
          version: "attempt-ref-v1",
          workItemId: attemptState.workItemId,
          attemptId: attemptState.attemptId,
          attemptSeq: attemptState.attemptSeq,
        },
      });
      expect(
        attemptEvents.kind === "authenticated_attempt" &&
          attemptEvents.events.map(({ event }) => event.eventType),
      ).toEqual([
        "dispatch.decision.v1",
        "work.created.v1",
        "attempt.allocated.v1",
        "effect.intent.v1",
      ]);
      expect(attemptEvents.kind === "authenticated_attempt" && attemptEvents.environment).toEqual(
        runtime.modelEnvironment,
      );
      await runtime.services.workerAttempts.commands.requestStart(attemptState);
      const task = {
        runId: attemptState.runId,
        sessionId: attemptState.sessionId,
        prompt: "runtime prompt",
      };
      const binding = {
        runtimeId: "runtime-production",
        workerId: "worker-1",
        generation: 1,
        principalId: "server",
        processId: 1001,
      };
      const definition = Ipc.WorkerRuntimeDefinitionV1.parse(await definitionPort(binding, task));
      expect(definition.attempt).toEqual({
        version: "attempt-ref-v1",
        workItemId: attemptState.workItemId,
        attemptId: attemptState.attemptId,
        attemptSeq: attemptState.attemptSeq,
      });
      expect(definition.config.model).toEqual({ provider: "anthropic", id: "claude-opus-4-5" });
      expect(definition.config.environment.modelDigest).toBe(Provider.modelDigest(productionModel));
      expect(definition.config.environment.credential.sourceKind).toBe("injected_runtime");
      expect(definition.config.environment.credential.sourcePathDigest).not.toBe(
        runtime.modelEnvironment.credential.sourcePathDigest,
      );
      const signer = createWorkerGenerationKeySigner(new Uint8Array(32).fill(7), {
        ...binding,
        attempt: definition.attempt,
      });
      const nonceRef = "b".repeat(64);
      const provisioning = await runtime.services.provisionCredentials(
        {
          channelIdentity: {
            ...binding,
            runId: attemptState.runId,
            sessionId: attemptState.sessionId,
            attempt: definition.attempt,
          },
          request: {
            version: "credential-provisioning-request-v1",
            runtimeId: binding.runtimeId,
            workerId: binding.workerId,
            generation: binding.generation,
            principalId: binding.principalId,
            attempt: definition.attempt,
            nonceRef,
            providerIds: [definition.config.model.provider],
            credentialRefs: [definition.config.environment.credential],
            expiresAt: Date.now() + 60_000,
          },
        },
        signer,
      );
      expect(provisioning.receipt.attempt).toEqual(definition.attempt);
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
        }),
      ).toMatchObject({ status: "starting", attemptSeq: attemptState.attemptSeq });
      const acknowledgement = {
        workerId: binding.workerId,
        generation: binding.generation,
        processId: binding.processId,
        runId: attemptState.runId,
        sessionId: attemptState.sessionId,
        receipt: provisioning.receipt,
      };
      await provisioning.acknowledge(acknowledgement);
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
        }),
      ).toMatchObject({ status: "running", attemptSeq: attemptState.attemptSeq });
      const workerSnapshotClaim = createProductionSnapshotBlob({
        id: "forged-work",
        sessionId: "forged-session",
        status: "completed",
      }).ref;
      const workerTransitionFrame = {
        channelIdentity: { ...binding, attempt: definition.attempt },
        request: {
          workerId: binding.workerId,
          generation: binding.generation,
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
          command: {
            version: "kernel-transition-command-v1" as const,
            transitionId: "WI-06",
            command: "kernel.work.record_evidence.v1",
            requestId: "worker-evidence-production",
            requestHash: digest,
            expectedHead: {},
            payload: {
              version: "native-transition-payload-v1",
              transitionId: "WI-06",
              command: "kernel.work.record_evidence.v1",
              owner: { version: "ledger-owner-v1", ownerKey: `work:${attemptState.workItemId}` },
              facts: {
                WI: {
                  subjectId: attemptState.workItemId,
                  occurredAtDbMs: Date.now(),
                  workItemId: attemptState.workItemId,
                  sessionId: attemptState.sessionId,
                  workSnapshotRef: workerSnapshotClaim,
                },
              },
            },
          },
        },
      };
      expect(await runtime.services.workerKernelTransition(workerTransitionFrame)).toMatchObject({
        status: "committed",
      });
      expect(
        await runtime.services.workerLedger.resolveWorkByRunId(attemptState.runId),
      ).toMatchObject({
        evidenceRefs: [expect.stringMatching(/^[0-9a-f]{64}$/)],
      });
      const readback = {
        kind: "url_fetch" as const,
        target: "https://example.com/result",
        passed: true,
        observedAt: 2,
        statusCode: 200,
        contentDigest: digest,
      };
      const readbackRef = createHash("sha256").update(canonicalJson(readback)).digest("hex");
      const readbackTarget = (await runtime.services.workerLedger.resolveWorkByRunId(
        attemptState.runId,
      )) as Record<string, unknown>;
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            readbackTarget,
            "WI-07",
            "worker-readback-production",
            readback,
            undefined,
            readbackRef,
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "committed" } });
      const duplicateReadbackTarget = (await runtime.services.workerLedger.resolveWorkByRunId(
        attemptState.runId,
      )) as Record<string, unknown>;
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            duplicateReadbackTarget,
            "WI-07",
            "worker-readback-duplicate",
            readback,
            undefined,
            readbackRef,
          ),
        ),
      ).toMatchObject({
        transitionResult: { status: "rejected", code: "idempotency_mismatch" },
      });
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            duplicateReadbackTarget,
            "WI-07",
            "worker-readback-forged",
            readback,
            undefined,
            "f".repeat(64),
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "rejected", code: "identity_mismatch" } });
      expect(
        await runtime.services.workerLedger.resolveWorkByRunId(attemptState.runId),
      ).toMatchObject({ readbackRefs: [readbackRef] });
      const semanticTarget = (await runtime.services.workerLedger.resolveWorkByRunId(
        attemptState.runId,
      )) as Record<string, unknown>;
      const sendRequestId = "worker-send-semantic-production";
      const sendRequest = workerSemanticRequest(semanticTarget, "DP-12", sendRequestId, {
        dispatchId: sendRequestId,
        sessionId: attemptState.sessionId,
        runId: attemptState.runId,
        message: "continue",
      });
      const sendIntent = await runtime.services.workerLedger.commitSemanticTransition(sendRequest);
      expect(sendIntent.transitionResult).toMatchObject({ status: "committed" });
      expect(sendIntent.effectBinding?.effect).toMatchObject({
        version: "effect-ref-v1",
        idempotencyKey: sendRequestId,
      });
      expect(sendIntent.effectBinding?.effectScope).toMatchObject({ version: "effect-scope-v1" });
      const sendReplay = await runtime.services.workerLedger.commitSemanticTransition(sendRequest);
      expect(sendReplay.transitionResult.status).toBe("committed");
      expect(sendReplay.effectBinding).toEqual(sendIntent.effectBinding);
      expect(
        await runtime.services.workerKernelTransition({
          ...workerTransitionFrame,
          request: {
            ...workerTransitionFrame.request,
            command: {
              ...workerTransitionFrame.request.command,
              requestId: "worker-evidence-forged-owner",
              payload: {
                ...workerTransitionFrame.request.command.payload,
                owner: { version: "ledger-owner-v1", ownerKey: "work:forged" },
              },
            },
          },
        }),
      ).toMatchObject({ status: "rejected" });
      await expect(provisioning.acknowledge(acknowledgement)).rejects.toThrow(
        "credential provisioning denied",
      );
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
        }),
      ).toMatchObject({
        status: "running",
        attemptId: attemptState.attemptId,
      });
      const workerQueryFrame = {
        channelIdentity: { ...binding, attempt: definition.attempt },
        request: {
          workerId: binding.workerId,
          generation: binding.generation,
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
          request: {
            version: "kernel-query-v1" as const,
            kind: "authenticated_attempt" as const,
            attempt: definition.attempt,
          },
        },
      };
      expect(await runtime.services.workerKernelQuery(workerQueryFrame)).toMatchObject({
        kind: "authenticated_attempt",
      });
      await expect(
        runtime.services.workerKernelQuery({
          ...workerQueryFrame,
          channelIdentity: {
            ...workerQueryFrame.channelIdentity,
            attempt: { ...workerQueryFrame.channelIdentity.attempt, attemptId: "forged-attempt" },
          },
        }),
      ).rejects.toThrow("authenticated worker identity mismatch: attemptId");

      await closeOwnedRuntime();
      const receiptDb = new Database(runtimePath);
      const settlementAppendRequestId = `${sendRequestId}:settlement`;
      const receiptRow = receiptDb
        .query("SELECT receipt_json FROM ledger_request WHERE request_id = ?")
        .get(settlementAppendRequestId) as { readonly receipt_json: string };
      receiptDb.close();
      const exactReceipt = JSON.parse(receiptRow.receipt_json) as Record<string, unknown>;
      const previousHead = exactReceipt.previousHead as Record<string, unknown>;
      const head = exactReceipt.head as Record<string, unknown>;
      const receiptOwner = exactReceipt.owner as Record<string, unknown>;
      const tamperedReceipts = [
        withReceiptHash({ ...exactReceipt, requestId: "tampered-request" }),
        withReceiptHash({ ...exactReceipt, requestHash: "d".repeat(64) }),
        withReceiptHash({ ...exactReceipt, principalId: "tampered-principal" }),
        withReceiptHash({
          ...exactReceipt,
          owner: { ...receiptOwner, ownerKey: "session:tampered" },
          previousHead: {
            ...previousHead,
            owner: { ...receiptOwner, ownerKey: "session:tampered" },
          },
          head: { ...head, owner: { ...receiptOwner, ownerKey: "session:tampered" } },
        }),
        withReceiptHash({
          ...exactReceipt,
          previousHead: { ...previousHead, eventHash: "d".repeat(64) },
        }),
        withReceiptHash({ ...exactReceipt, head: { ...head, eventHash: "d".repeat(64) } }),
        withReceiptHash({
          ...exactReceipt,
          firstLedgerSeq: (exactReceipt.firstLedgerSeq as number) + 10,
          lastLedgerSeq: (exactReceipt.lastLedgerSeq as number) + 10,
        }),
        withReceiptHash({
          ...exactReceipt,
          previousHead: {
            ...previousHead,
            ownerSeq: (previousHead.ownerSeq as number) + 1,
          },
          head: { ...head, ownerSeq: (head.ownerSeq as number) + 1 },
        }),
        withReceiptHash({ ...exactReceipt, eventIds: ["tampered-event"] }),
        { ...exactReceipt, receiptHash: "d".repeat(64) },
      ];
      for (const tamperedReceipt of tamperedReceipts) {
        const tamperDb = new Database(runtimePath);
        tamperDb
          .query("UPDATE ledger_request SET receipt_json = ? WHERE request_id = ?")
          .run(canonicalJson(tamperedReceipt), settlementAppendRequestId);
        tamperDb.close();
        await reopenOwnedRuntime();
        expect(
          await runtime.services.workerLedger.commitSemanticTransition(sendRequest),
        ).toMatchObject({ transitionResult: { status: "rejected" } });
        await closeOwnedRuntime();
      }
      const restoreDb = new Database(runtimePath);
      restoreDb
        .query("UPDATE ledger_request SET receipt_json = ? WHERE request_id = ?")
        .run(receiptRow.receipt_json, settlementAppendRequestId);
      restoreDb.close();
      await reopenOwnedRuntime();
      const sendBinding = sendIntent.effectBinding;
      const effectSettlement = await runtime.services.workerLedger.commitSemanticTransition(
        workerSemanticRequest(
          semanticTarget,
          "EF-01",
          `${sendRequestId}:effect-settlement`,
          { outcome: "confirmed" },
          sendBinding,
        ),
      );
      expect(effectSettlement.transitionResult.status).toBe("committed");

      const cancelRequestId = "worker-cancel-semantic-production";
      const cancelIntent = await runtime.services.workerLedger.commitSemanticTransition(
        workerSemanticRequest(semanticTarget, "DP-14", cancelRequestId, {
          dispatchId: cancelRequestId,
          runId: attemptState.runId,
        }),
      );
      expect(cancelIntent).toMatchObject({
        transitionResult: { status: "committed" },
        effectBinding: { effect: { idempotencyKey: cancelRequestId } },
      });
      const forgedBinding = {
        ...cancelIntent.effectBinding,
        effect: { ...cancelIntent.effectBinding?.effect, effectId: "worker-effect:forged" },
      };
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            semanticTarget,
            "EF-02",
            `${cancelRequestId}:forged-settlement`,
            { outcome: "definite_failed" },
            forgedBinding,
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "rejected" } });
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            semanticTarget,
            "EF-02",
            `${cancelRequestId}:settlement`,
            { outcome: "definite_failed" },
            cancelIntent.effectBinding,
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "committed" } });
      const completionEvidenceRef = (semanticTarget.evidenceRefs as readonly string[])[0];
      if (completionEvidenceRef === undefined)
        throw new Error("Worker evidence projection is missing");
      const completionReport = {
        summary: "Worker completed the runtime task.",
        claims: [{ statement: "Runtime task completed.", evidenceIds: [completionEvidenceRef] }],
        caveats: [],
        followUps: [],
      };
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            semanticTarget,
            "DP-07",
            `${attemptState.runId}:completion-candidate`,
            completionReport,
            undefined,
            createHash("sha256").update(canonicalJson(completionReport)).digest("hex"),
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "committed" } });
      const claim = completionReport.claims[0];
      if (claim === undefined) throw new Error("Completion report claim is missing");
      const candidateRef = createHash("sha256")
        .update(canonicalJson(completionReport))
        .digest("hex");
      const candidateEvents = await runtime.queries.query({
        version: "kernel-query-v1",
        kind: "authenticated_attempt",
        identity: {
          version: "authenticated-worker-identity-v1",
          runtimeId: binding.runtimeId,
          workerId: binding.workerId,
          generation: binding.generation,
          principalId: binding.principalId,
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
          attemptId: attemptState.attemptId,
        },
        attempt: definition.attempt,
      });
      if (candidateEvents.kind !== "authenticated_attempt")
        throw new Error("Completion candidate history is missing");
      const candidateEnvelope = candidateEvents.events.find(
        ({ event }) => event.eventType === "completion.candidate.submitted.v1",
      );
      if (candidateEnvelope === undefined) throw new Error("Completion candidate event is missing");
      const verdict = {
        version: "completion-claim-verdict-v1",
        candidateRef,
        candidate: completionReport,
        claimIndex: 0,
        claimDigest: createHash("sha256").update(canonicalJson(claim)).digest("hex"),
        evidenceIds: claim.evidenceIds,
        status: "passed",
      } as const;
      const verdictRef = createHash("sha256").update(canonicalJson(verdict)).digest("hex");
      const arbitraryVerdict = { ...verdict, claimDigest: "e".repeat(64) };
      const arbitraryVerdictRef = createHash("sha256")
        .update(canonicalJson(arbitraryVerdict))
        .digest("hex");
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            semanticTarget,
            "CP-02",
            `${attemptState.runId}:completion-verdict:arbitrary`,
            arbitraryVerdict,
            undefined,
            arbitraryVerdictRef,
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "rejected" } });
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            semanticTarget,
            "CP-02",
            `${attemptState.runId}:completion-verdict:0`,
            verdict,
            undefined,
            verdictRef,
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "committed" } });
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            semanticTarget,
            "CP-02",
            `${attemptState.runId}:completion-verdict:duplicate`,
            verdict,
            undefined,
            verdictRef,
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "rejected" } });
      const admission = {
        "AC-1": true,
        "AC-2": true,
        "AC-3": true,
        "AC-4": true,
        "AC-5": true,
        "AC-6": true,
      } as const;
      const admissionDecision = (
        verdicts: readonly (typeof verdict)[],
        verdictRefs: readonly string[],
      ) => ({
        version: "completion-admission-decision-v1" as const,
        candidate: completionReport,
        candidateRef,
        verdicts,
        verdictRefs,
        stakesAsOfLedgerSeq: candidateEnvelope.ledgerSeq,
        stakesAsOfDbMs: candidateEnvelope.committedAtDbMs,
        admission,
      });
      for (const [suffix, decision] of [
        ["arbitrary", admissionDecision([arbitraryVerdict], [arbitraryVerdictRef])],
        ["duplicate", admissionDecision([verdict, verdict], [verdictRef, verdictRef])],
        ["mismatched", admissionDecision([verdict], ["f".repeat(64)])],
      ] as const) {
        expect(
          await runtime.services.workerLedger.commitSemanticTransition(
            workerSemanticRequest(
              semanticTarget,
              "CP-04",
              `${attemptState.runId}:completion-admit:${suffix}`,
              decision,
              undefined,
              createHash("sha256").update(canonicalJson(decision)).digest("hex"),
            ),
          ),
        ).toMatchObject({ transitionResult: { status: "rejected" } });
      }
      const exactAdmissionDecision = admissionDecision([verdict], [verdictRef]);
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            semanticTarget,
            "CP-04",
            `${attemptState.runId}:completion-admit`,
            exactAdmissionDecision,
            undefined,
            createHash("sha256").update(canonicalJson(exactAdmissionDecision)).digest("hex"),
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "committed" } });
      expect(
        await runtime.services.workerLedger.resolveWorkByRunId(attemptState.runId),
      ).toMatchObject({
        status: "completed",
      });
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
        }),
      ).toMatchObject({ status: "succeeded" });
      const terminalAttemptEvents = await runtime.queries.query({
        version: "kernel-query-v1",
        kind: "authenticated_attempt",
        identity: {
          version: "authenticated-worker-identity-v1",
          runtimeId: binding.runtimeId,
          workerId: binding.workerId,
          generation: binding.generation,
          principalId: binding.principalId,
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
          attemptId: attemptState.attemptId,
        },
        attempt: definition.attempt,
      });
      expect(
        terminalAttemptEvents.kind === "authenticated_attempt" &&
          terminalAttemptEvents.events.map(({ event }) => event.eventType),
      ).toEqual(
        expect.arrayContaining([
          "attempt.running.v1",
          "dispatch.received.v1",
          "effect.intent.v1",
          "effect.confirmed.v1",
          "effect.definite_failed.v1",
          "attempt.succeeded.v1",
          "completion.candidate.submitted.v1",
          "completion.claim_verdict_recorded.v1",
          "completion.decision_recorded.v1",
          "work.completed.v1",
        ]),
      );
      expect(await runtime.services.recoverInterruptedRuns()).toMatchObject({ recovered: 0 });
      const cancelledAttempt = await allocateCommittedAttempt({
        sessionId: "session-worker-cancelled",
        runId: "run-worker-cancelled",
        title: "cancelled worker",
        prompt: "cancel worker",
        agentName: "dev",
      });
      const cancelledTarget = (await runtime.services.workerLedger.resolveWorkByRunId(
        cancelledAttempt.runId,
      )) as Record<string, unknown>;
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(cancelledTarget, "DP-09", `${cancelledAttempt.runId}:cancelled`, {
            status: "cancelled",
          }),
        ),
      ).toMatchObject({ transitionResult: { status: "committed" } });
      expect(
        await runtime.services.workerLedger.resolveWorkByRunId(cancelledAttempt.runId),
      ).toMatchObject({
        status: "cancelled",
      });

      const interruptedAttempt = await allocateCommittedAttempt({
        sessionId: "session-worker-interrupted",
        runId: "run-worker-interrupted",
        title: "interrupted worker",
        prompt: "interrupt worker",
        agentName: "dev",
      });
      await runtime.services.workerAttempts.commands.requestStart(interruptedAttempt);
      const interruptedTarget = (await runtime.services.workerLedger.resolveWorkByRunId(
        interruptedAttempt.runId,
      )) as Record<string, unknown>;
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            interruptedTarget,
            "DP-11",
            `${interruptedAttempt.runId}:interrupted`,
            { reason: "server restart" },
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "committed" } });
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: interruptedAttempt.sessionId,
          runId: interruptedAttempt.runId,
        }),
      ).toMatchObject({ status: "interrupted" });

      const waitOpenInput = {
        waitId: "wait-production",
        ownerRef: { version: "wait-owner-ref-v1", kind: "workItem", id: attemptState.workItemId },
        sessionId: attemptState.sessionId,
        expectedResponders: [
          { version: "wait-responder-ref-v1", actorId: "owner" },
          { version: "wait-responder-ref-v1", actorId: "reviewer" },
        ],
        correlation: { version: "wait-correlation-v1", tokenHash: digest },
        allowedActions: ["report_result", "decline_task"],
        resolutionPolicy: "quorum",
        quorum: { version: "wait-quorum-v1", required: 2, total: 2 },
        deadline: Date.now() + 60_000,
        route: { kind: "resident" },
        attempt: {
          version: "attempt-ref-v1",
          workItemId: attemptState.workItemId,
          attemptId: attemptState.attemptId,
          attemptSeq: attemptState.attemptSeq,
        },
      };
      await runtime.services.waitKernel.open(waitOpenInput);
      const firstWaitResponse = {
        waitId: "wait-production",
        transportId: "transport-production-owner",
        responder: { version: "wait-responder-ref-v1", actorId: "owner" },
        action: "report_result",
        payload: { approved: true },
      };
      expect(await runtime.services.waitKernel.acceptResponse(firstWaitResponse)).toMatchObject({
        status: "open",
        responses: [expect.objectContaining({ action: "report_result" })],
      });
      expect(await runtime.services.waitKernel.acceptResponse(firstWaitResponse)).toMatchObject({
        status: "open",
        responses: [expect.objectContaining({ transportId: "transport-production-owner" })],
      });
      await expect(
        runtime.services.waitKernel.acceptResponse({
          ...firstWaitResponse,
          transportId: "transport-production-invalid-action",
          responder: { version: "wait-responder-ref-v1", actorId: "reviewer" },
          action: "ask_clarification",
        }),
      ).rejects.toThrow("action is not allowed");
      const settledWait = await runtime.services.waitKernel.settle({
        waitId: "wait-production",
        transportId: "transport-production-reviewer",
        responder: { version: "wait-responder-ref-v1", actorId: "reviewer" },
        action: "decline_task",
        payload: { approved: false },
      });
      expect(settledWait).toMatchObject({
        status: "resolved",
        responses: [
          expect.objectContaining({ responder: expect.objectContaining({ actorId: "owner" }) }),
          expect.objectContaining({ responder: expect.objectContaining({ actorId: "reviewer" }) }),
        ],
      });
      const resumeTarget = (await runtime.services.workerLedger.resolveWorkByRunId(
        attemptState.runId,
      )) as Record<string, unknown>;
      const resumeRequestId = "worker-resume-semantic-production";
      const resumeIntent = await runtime.services.workerLedger.commitSemanticTransition(
        workerSemanticRequest(resumeTarget, "DP-13", resumeRequestId, {
          dispatchId: resumeRequestId,
          sessionId: attemptState.sessionId,
          runId: attemptState.runId,
          message: "resume",
        }),
      );
      expect(resumeIntent).toMatchObject({
        transitionResult: { status: "committed" },
        effectBinding: { effect: { idempotencyKey: resumeRequestId } },
      });
      const resumeSettlementTarget = (await runtime.services.workerLedger.resolveWorkByRunId(
        attemptState.runId,
      )) as Record<string, unknown>;
      expect(
        await runtime.services.workerLedger.commitSemanticTransition(
          workerSemanticRequest(
            resumeSettlementTarget,
            "EF-03",
            `${resumeRequestId}:settlement`,
            { outcome: "unknown" },
            resumeIntent.effectBinding,
          ),
        ),
      ).toMatchObject({ transitionResult: { status: "committed" } });
      await runtime.services.waitKernel.markRouted({
        waitId: "wait-production",
        dispatchId: "wait:wait-production:threshold",
        action: "decline_task",
      });
      const ambiguityWait = (waitId: string) =>
        runtime.services.waitKernel.open({
          waitId,
          ownerRef: {
            version: "wait-owner-ref-v1",
            kind: "workItem",
            id: attemptState.workItemId,
          },
          sessionId: attemptState.sessionId,
          expectedResponders: [{ version: "wait-responder-ref-v1", actorId: "owner" }],
          endpointId: "endpoint-wait",
          channelId: "channel-wait",
          correlation: { version: "wait-correlation-v1", tokenHash: digest },
          allowedActions: ["report_result"],
          deadline: Date.now() + 60_000,
          route: { kind: "resident" },
          attempt: definition.attempt,
        });
      const ambiguityA = await ambiguityWait("wait-ambiguity-a");
      const ambiguityB = await ambiguityWait("wait-ambiguity-b");
      expect(
        await runtime.services.waitKernel.correlate({
          endpointId: "endpoint-wait",
          channelId: "channel-wait",
          correlation: { version: "wait-correlation-v1", tokenHash: digest },
        }),
      ).toMatchObject({
        kind: "ambiguous",
        candidates: [{ wait: ambiguityA }, { wait: ambiguityB }],
      });
      expect(
        await runtime.services.waitKernel.correlate({
          endpointId: "endpoint-wait",
          channelId: "channel-wait",
          correlation: { version: "wait-correlation-v1", tokenHash: "0".repeat(64) },
        }),
      ).toEqual({ kind: "none", candidates: [] });
      await runtime.services.waitKernel.stageAmbiguity({
        transportId: "transport-ambiguous",
        candidates: [
          { key: "wait:wait-ambiguity-a", wait: ambiguityA },
          { key: "wait:wait-ambiguity-b", wait: ambiguityB },
        ],
      });
      expect(
        await runtime.services.waitKernel.revalidatePinned({
          pinned: { waitId: "wait-ambiguity-a" },
          requestedAction: "report_result",
        }),
      ).toMatchObject({ kind: "valid", wait: { waitId: "wait-ambiguity-a", status: "open" } });

      const residentWaitAttempt = await allocateCommittedAttempt({
        sessionId: "session-resident-wait-worker",
        parentSessionId: command.sessionId,
        runId: "run-resident-wait-worker",
        title: "resident Wait worker",
        prompt: "ask the Resident",
        agentName: "dev",
      });
      await runtime.services.workerAttempts.commands.requestStart(residentWaitAttempt);
      const residentWaitBinding = { ...binding, generation: 2, processId: 1002 };
      const residentWaitDefinition = Ipc.WorkerRuntimeDefinitionV1.parse(
        await definitionPort(residentWaitBinding, {
          runId: residentWaitAttempt.runId,
          sessionId: residentWaitAttempt.sessionId,
          prompt: "ask the Resident",
        }),
      );
      const residentWaitSigner = createWorkerGenerationKeySigner(new Uint8Array(32).fill(9), {
        ...residentWaitBinding,
        attempt: residentWaitDefinition.attempt,
      });
      const residentWaitProvisioning = await runtime.services.provisionCredentials(
        {
          channelIdentity: {
            ...residentWaitBinding,
            runId: residentWaitAttempt.runId,
            sessionId: residentWaitAttempt.sessionId,
            attempt: residentWaitDefinition.attempt,
          },
          request: {
            version: "credential-provisioning-request-v1",
            runtimeId: residentWaitBinding.runtimeId,
            workerId: residentWaitBinding.workerId,
            generation: residentWaitBinding.generation,
            principalId: residentWaitBinding.principalId,
            attempt: residentWaitDefinition.attempt,
            nonceRef: "c".repeat(64),
            providerIds: [residentWaitDefinition.config.model.provider],
            credentialRefs: [residentWaitDefinition.config.environment.credential],
            expiresAt: Date.now() + 60_000,
          },
        },
        residentWaitSigner,
      );
      await residentWaitProvisioning.acknowledge({
        workerId: residentWaitBinding.workerId,
        generation: residentWaitBinding.generation,
        processId: residentWaitBinding.processId,
        runId: residentWaitAttempt.runId,
        sessionId: residentWaitAttempt.sessionId,
        receipt: residentWaitProvisioning.receipt,
      });
      const residentAsk = {
        requestId: "resident-ask-call-production",
        sourceSessionId: residentWaitAttempt.sessionId,
        sourceRunId: residentWaitAttempt.runId,
        targetSessionId: command.sessionId,
        workItemId: residentWaitAttempt.workItemId,
        attemptId: residentWaitAttempt.attemptId,
        attemptSeq: residentWaitAttempt.attemptSeq,
        payload: "Should I proceed?",
      };
      await expect(
        runtime.services.residentInboundWait.commands.resumeAfterResolvedWait(
          residentAsk.requestId,
        ),
      ).rejects.toThrow("durably resolved Wait");
      const residentWait =
        await runtime.services.residentInboundWait.commands.openResidentAsk(residentAsk);
      expect(residentWait).toMatchObject({
        waitId: residentAsk.requestId,
        correlation: {
          endpointId: "resident",
          channelId: `worker:${residentAsk.sourceSessionId}:${residentAsk.sourceRunId}`,
        },
      });
      await expect(
        runtime.services.residentInboundWait.commands.openResidentAsk(residentAsk),
      ).resolves.toEqual(residentWait);
      await expect(
        runtime.services.residentInboundWait.commands.openResidentAsk({
          ...residentAsk,
          attemptId: "attempt-cross-boundary",
        }),
      ).rejects.toThrow("Attempt transition denied: Attempt not found");
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: residentWaitAttempt.sessionId,
          runId: residentWaitAttempt.runId,
        }),
      ).toMatchObject({ status: "waiting" });
      await runtime.services.waitKernel.settle({
        waitId: residentWait.waitId,
        transportId: "resident-ask-response-production",
        responder: { version: "wait-responder-ref-v1", actorId: "resident" },
        action: "report_result",
        payload: "Proceed",
      });
      const residentResume =
        await runtime.services.residentInboundWait.commands.resumeAfterResolvedWait(
          residentWait.waitId,
        );
      expect(residentResume.disposition).toBe("act");
      if (residentResume.disposition !== "act") throw new Error("expected new resume intent");
      await runtime.services.workerAttempts.commands.settleDelivery({
        attempt: { ...residentWaitAttempt, status: "waiting" },
        delivery: residentResume.delivery,
        accepted: true,
      });
      expect(
        await runtime.services.residentInboundWait.commands.resumeAfterResolvedWait(
          residentWait.waitId,
        ),
      ).toMatchObject({ disposition: "terminal", outcome: "confirmed" });
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: residentWaitAttempt.sessionId,
          runId: residentWaitAttempt.runId,
        }),
      ).toMatchObject({ status: "running" });
      const residentWaitEvents = await runtime.queries.query({
        version: "kernel-query-v1",
        kind: "authenticated_attempt",
        identity: {
          version: "authenticated-worker-identity-v1",
          runtimeId: residentWaitBinding.runtimeId,
          workerId: residentWaitBinding.workerId,
          generation: residentWaitBinding.generation,
          principalId: residentWaitBinding.principalId,
          sessionId: residentWaitAttempt.sessionId,
          runId: residentWaitAttempt.runId,
          attemptId: residentWaitAttempt.attemptId,
        },
        attempt: residentWaitDefinition.attempt,
      });
      const residentWaitEventTypes =
        residentWaitEvents.kind === "authenticated_attempt"
          ? residentWaitEvents.events.map(({ event }) => event.eventType)
          : [];
      expect(residentWaitEventTypes.filter((event) => event === "wait.opened.v1")).toHaveLength(1);
      expect(
        residentWaitEventTypes.filter((event) => event === "dispatch.pending.v1"),
      ).toHaveLength(2);
      expect(residentWaitEventTypes.filter((event) => event === "attempt.waiting.v1")).toHaveLength(
        1,
      );
      expect(
        residentWaitEventTypes.filter((event) => event === "wait.resume_requested.v1"),
      ).toHaveLength(1);

      const coordinatorCalls: Array<{
        kind: "dispatch" | "delivery";
        sessionId: string;
        runId?: string;
        payload: unknown;
      }> = [];
      const coordinator = {
        async dispatch(sessionId: string, request: Execution.Request) {
          coordinatorCalls.push({
            kind: "dispatch",
            sessionId,
            runId: request.runId,
            payload: request,
          });
          return {
            sessionId,
            runId: request.runId,
            status: "interrupted" as const,
            error: "test coordinator retained the allocation boundary",
          };
        },
        async deliverMessage(sessionId: string, message: string, runId?: string) {
          coordinatorCalls.push({ kind: "delivery", sessionId, runId, payload: message });
          return { accepted: true };
        },
      };
      const dispatchRuntime = createDefaultDispatchRuntime({
        owners: {
          coordinator,
          defaultModel: { provider: "anthropic", id: "claude-opus-4-5" },
        },
        waitKernel: runtime.services.waitKernel,
        authorityQueries: runtime.services.authorityQueries,
        effects: runtime.services.effects,
        scheduleService: runtime.services.scheduleService,
        workerAttempts: runtime.services.workerAttempts,
        workerLedger: runtime.services.workerLedger,
      });
      const spawnSessionId = "session-resident-channel-spawn";
      const spawnRunId = "run-resident-channel-spawn";
      const spawnResult = await dispatchRuntime.submit(
        {
          action: "worker.spawn",
          target: { kind: "worker", name: "dev", sessionId: spawnSessionId, runId: spawnRunId },
          payload: {
            prompt: "Perform the Resident-approved channel task",
            acceptanceCriteria: ["Return an evidence-backed result"],
            constraints: ["Use only the assigned Attempt"],
          },
        },
        {
          actorKind: "resident",
          actorId: "resident",
          agentName: "resident",
          sessionId: command.sessionId,
        },
      );
      expect(spawnResult).toMatchObject({ status: "completed" });
      expect(coordinatorCalls).toEqual([
        {
          kind: "dispatch",
          sessionId: spawnSessionId,
          runId: spawnRunId,
          payload: expect.objectContaining({
            sessionId: spawnSessionId,
            runId: spawnRunId,
            prompt: "Perform the Resident-approved channel task",
          }),
        },
      ]);
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: spawnSessionId,
          runId: spawnRunId,
        }),
      ).toMatchObject({ status: "interrupted", sessionId: spawnSessionId, runId: spawnRunId });

      IngressEngine.setMessagingLedgerService(runtime.services.messagingLedger);
      IngressEngine.setKernelPorts(runtime.services.ingressKernel);
      IngressEngine.setCoordinator(coordinator);
      IngressEngine.setDispatchRuntime(dispatchRuntime);
      const emptyProvider = { listTools: () => [] };
      const channelHandler = createMessageHandler({
        systemProvider: emptyProvider,
        agentProvider: emptyProvider,
        mcpProvider: emptyProvider,
        defaultModel: { provider: "anthropic", id: "claude-opus-4-5" },
        workspaceRoot: root,
        ownerTaskQueries: runtime.services.ownerTaskQueries,
        modelCatalog: runtime.services.modelCatalog,
        secretRegistry: runtime.services.secretRegistry,
        credentialHandle: runtime.services.modelCredential,
        modelEnvironment: runtime.services.modelEnvironment,
      });
      const channelNormalizer = new DiscordNormalizer({ botId: "bot-1", triggers: [] });
      const normalizeChannelMessage = (
        id: string,
        content: string,
        replyToId?: string,
        correlationToken?: string,
      ) => {
        const rawMessage = {
          id,
          channel_id: "dev",
          guild_id: "guild-1",
          author: { id: "owner-1", username: "Owner" },
          content,
          ...(replyToId === undefined ? {} : { message_reference: { message_id: replyToId } }),
          ...(correlationToken === undefined ? {} : { correlationToken }),
        };
        const message = channelNormalizer.normalize(rawMessage);
        if (!message) throw new Error("expected normalized Discord message");
        return message;
      };
      const channelCorrelationToken = "channel-worker-result-token";
      const channelCorrelationTokenHash = createHash("sha256")
        .update("openomni.ingress.correlation-token.v1\0")
        .update(channelCorrelationToken)
        .digest("hex");

      const unauthorizedResponse = await channelHandler(
        normalizeChannelMessage("channel-unmatched", "Uncorrelated worker instruction"),
      );
      expect(unauthorizedResponse).toEqual({ text: "Error: channel_grant.missing" });
      expect(coordinatorCalls).toHaveLength(1);

      const channelWait = await runtime.services.waitKernel.open({
        waitId: "wait-channel-worker-result",
        ownerRef: {
          version: "wait-owner-ref-v1",
          kind: "workItem",
          id: residentWaitAttempt.workItemId,
        },
        sessionId: residentWaitAttempt.sessionId,
        expectedResponders: [
          { version: "wait-responder-ref-v1", actorId: "bot-1", endpointId: "bot-1" },
        ],
        endpointId: "bot-1",
        channelId: "dev",
        correlation: {
          version: "wait-correlation-v1",
          replyToMessageId: "worker-result-question",
          externalConversationId: "discord:bot-1:channel:dev",
          tokenHash: channelCorrelationTokenHash,
        },
        allowedActions: ["report_result"],
        deadline: Date.now() + 60_000,
        route: {
          kind: "worker",
          sessionId: residentWaitAttempt.sessionId,
          runId: residentWaitAttempt.runId,
        },
        attempt: residentWaitDefinition.attempt,
      });
      expect(channelWait.status).toBe("open");
      const authorizedResponse = await channelHandler(
        normalizeChannelMessage(
          "channel-correlated-result",
          "Resident-approved Worker result",
          "worker-result-question",
          channelCorrelationToken,
        ),
      );
      expect(authorizedResponse).toEqual({ text: "(no response)" });
      expect(coordinatorCalls).toHaveLength(1);
      expect(
        await runtime.services.workerAttempts.queries.byExecution({
          sessionId: residentWaitAttempt.sessionId,
          runId: residentWaitAttempt.runId,
        }),
      ).toMatchObject({ status: "running" });
      expect(
        await runtime.services.waitKernel.correlate({
          endpointId: "bot-1",
          channelId: "dev",
          correlation: {
            version: "wait-correlation-v1",
            replyToMessageId: "worker-result-question",
            externalConversationId: "discord:bot-1:channel:dev",
            tokenHash: channelCorrelationTokenHash,
          },
        }),
      ).toEqual({ kind: "none", candidates: [] });
      expect(
        await runtime.services.workerLedger.resolveWorkByRunId(residentWaitAttempt.runId),
      ).toMatchObject({
        runId: residentWaitAttempt.runId,
        attempt: residentWaitDefinition.attempt,
      });
      expect(
        await runtime.services.scheduleService.create({
          scheduleId: "schedule-production",
          agentName: "resident",
          target: { kind: "resident", sessionId: command.sessionId },
          expression: "* * * * *",
          payloadRef: "payload-production",
        }),
      ).toBe("schedule-production");
      expect((await runtime.services.scheduleService.get("schedule-production"))?.status).toBe(
        "active",
      );
      expect(
        await runtime.services.authorityQueries.query({
          kind: "authority.actor_by_endpoint",
          surface: "internal",
          externalId: "missing",
        }),
      ).toMatchObject({ identity: null, endpoint: null });
    } finally {
      if (previousAuthFile === undefined) delete process.env.OPENOMNI_AUTH_FILE;
      else process.env.OPENOMNI_AUTH_FILE = previousAuthFile;
    }
  });
  test("connector structural wiring settles the authoritative start effect with running", () => {
    const source = readFileSync(
      new URL("../../../../packages/openomni/src/ledger/production/adapters.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('input.transitionId === "AT-02"');
    expect(source).toContain('settlement: "pending"');
    expect(source).toContain("const effectProjection = await runtime.query");
    expect(source).toContain('input.transitionId === "AT-03"');
    expect(source).toContain('settlement: "confirmed"');
    expect(source).toContain("effectScopeRef: Execution.ContentBlobRefV1.parse");
    expect(source).toContain('? "running"');
  });
});
