import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Execution, type AppConnector, type Ledger } from "@openomni/protocol";
import {
  type ConfigurationOperationIdV1,
  prepareConfigurationArtifactTransition,
} from "../../src/ledger/transitions/configuration-artifact.js";
import { createAuthorityReducer } from "../../src/ledger/reducers/authority.js";
import { createConnectorArtifactReducer } from "../../src/ledger/reducers/connector-artifact.js";

const owner = { version: "ledger-owner-v1", ownerKey: "configuration:owner-1" } as const;
const head = {
  version: "ledger-head-v1",
  owner,
  ownerSeq: 0,
  eventHash: "GENESIS_V1",
} as const;
const identity = {
  version: "authenticated-worker-identity-v1",
  runtimeId: "runtime-1",
  workerId: "worker-1",
  generation: 1,
  principalId: "owner-principal",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
} as const;

const pairs = Object.fromEntries(
  Execution.ConfigurationOperationCatalogV1.map(({ id, command }) => [id, command]),
) as Record<string, string>;

type PayloadExtra = Record<string, unknown>;
function command(
  operationId: string,
  subjectId: string,
  recordVersion: number,
  extra: PayloadExtra,
) {
  const payload = {
    version: "configuration-operation-payload-v1" as const,
    operationId,
    command: pairs[operationId],
    owner,
    subjectId,
    recordVersion,
    occurredAtDbMs: 1_000 + recordVersion,
    ...extra,
  };
  const snapshotBytes = new TextEncoder().encode(
    canonicalJson({
      version: "configuration-artifact-v1",
      operationId,
      command: pairs[operationId],
      owner,
      subjectId,
      recordVersion,
      occurredAtDbMs: payload.occurredAtDbMs,
      payload,
    }),
  );
  const configurationSnapshotRef = {
    version: "content-blob-ref-v1" as const,
    digest: createHash("sha256").update(snapshotBytes).digest("hex"),
    byteLength: snapshotBytes.byteLength,
    mediaType: "application/json",
  };
  return Execution.KernelTransitionCommandV1.parse({
    version: "kernel-transition-command-v1",
    transitionId: operationId,
    command: pairs[operationId],
    requestId: `request-${operationId}-${recordVersion}`,
    requestHash: "a".repeat(64),
    identity,
    expectedHead: head,
    payload: { ...payload, configurationSnapshotRef },
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function installation(status: AppConnector.InstallationStatus, updatedAt: number) {
  const consent = {
    grantedBy: "owner-principal",
    grantedAt: 1_003,
    permissions: [],
  };
  return {
    id: "installation-1",
    connectorId: "connector-1",
    connectorVersion: "1.0.0",
    endpointId: "connector:endpoint-1",
    definition: {
      id: "connector-1",
      name: "Test Connector",
      version: "1.0.0",
      description: "test connector",
      detect: { command: "connector", testedVersions: ">=1" },
      spawn: { command: "connector" },
      driver: {
        provider: "test",
        install: { scopes: ["user"] },
        submit: { mode: "spawn", ack: "running" },
        observedEvents: [],
        emits: [],
      },
      evidence: { emits: ["exit_code"] },
      requires: {},
      profile: { kind: "connector_endpoint", taskTypes: ["test"] },
    },
    testedVersions: ">=1",
    status,
    registeredBy: "owner-principal",
    ...(status === "consented" || status === "enabled" || status === "disabled" ? { consent } : {}),
    createdAt: 1_001,
    updatedAt,
  };
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function prepareSequence(commands: readonly ReturnType<typeof command>[]) {
  const prepared: ReturnType<typeof prepareConfigurationArtifactTransition>[] = [];
  const priorBySubject = new Map<
    string,
    { count: number; snapshotRef: Execution.ContentBlobRefV1 }
  >();
  for (const value of commands) {
    const subjectId = value.payload.subjectId;
    const prior = priorBySubject.get(subjectId);
    const next = prepareConfigurationArtifactTransition(value, {
      priorRecordCount: prior?.count ?? 0,
      priorOperationIds: commands
        .slice(0, prepared.length)
        .filter((candidate) => candidate.payload.subjectId === subjectId)
        .map((candidate) => candidate.transitionId as ConfigurationOperationIdV1),
      ...(prior === undefined ? {} : { priorSnapshotRef: prior.snapshotRef }),
    });
    prepared.push(next);
    priorBySubject.set(subjectId, {
      count: (prior?.count ?? 0) + 1,
      snapshotRef: value.payload.configurationSnapshotRef,
    });
  }
  return prepared;
}

function envelope(
  prepared: ReturnType<typeof prepareConfigurationArtifactTransition>,
  ownerSeq: number,
): Ledger.EnvelopeV1 {
  return {
    version: "ledger-envelope-v1",
    envelopeVersion: 1,
    ledgerSeq: ownerSeq,
    ownerSeq,
    previousEventHash: ownerSeq === 1 ? "GENESIS_V1" : "b".repeat(64),
    eventHash: "b".repeat(64),
    event: requireValue(prepared.append.batch.events[0], "prepared event is missing"),
    batch: {
      version: "ledger-batch-position-v1",
      batchId: prepared.append.batch.batchId,
      index: 0,
      size: 1,
    },
    requestId: prepared.append.requestId,
    requestHash: prepared.append.requestHash,
    principalId: prepared.append.principalId,
    committedAtDbMs: prepared.artifact.occurredAtDbMs,
  };
}

describe("configuration artifact transition family", () => {
  test("prepares every one of the 23 closed operations with immutable projection input", () => {
    const content = Buffer.from("hello");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const actor = {
      id: "actor-1",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    } as const;
    const endpoint = {
      id: "endpoint-1",
      actorId: actor.id,
      channel: "test",
      externalId: "external-1",
    };
    const entry = { id: "blacklist-1", kind: "actor", value: actor.id, createdBy: "owner" };
    const grant = {
      id: "grant-1",
      surface: "test",
      kind: "trusted_channel",
      createdBy: "owner",
    };

    const groups = [
      [
        command("AF-01", "artifact-1", 1, {
          artifactId: "artifact-1",
          contentRef: {
            version: "content-blob-ref-v1",
            digest: contentHash,
            byteLength: content.byteLength,
            mediaType: "text/plain",
          },
          title: "hello",
        }),
      ],
      [
        command("AI-01", actor.id, 1, { identity: actor }),
        command("AI-02", actor.id, 2, { identity: { ...actor, displayName: "Owner" } }),
        command("AI-03", actor.id, 3, {}),
      ],
      [
        command("AE-01", endpoint.id, 1, { endpoint }),
        command("AE-02", endpoint.id, 2, { endpoint: { ...endpoint, displayName: "Endpoint" } }),
        command("AE-03", endpoint.id, 3, {}),
      ],
      [
        command("BL-01", entry.id, 1, { entry }),
        command("BL-02", entry.id, 2, { entry: { ...entry, reason: "revised" } }),
        command("BL-03", entry.id, 3, {}),
      ],
      [
        command("BL-01", entry.id, 1, { entry }),
        command("BL-02", entry.id, 2, { entry: { ...entry, expiresAt: 999 } }),
        command("BL-04", entry.id, 3, {}),
      ],
      [
        command("CG-01", grant.id, 1, { grant }),
        command("CG-02", grant.id, 2, { grant: { ...grant, inboundTreatment: "full_access" } }),
        command("CG-03", grant.id, 3, {}),
      ],
      [
        command("CI-01", "installation-1", 1, { installation: installation("registered", 1) }),
        command("CI-02", "installation-1", 2, { installation: installation("registered", 2) }),
        command("CI-03", "installation-1", 3, { installation: installation("pending_consent", 3) }),
        command("CI-04", "installation-1", 4, { installation: installation("consented", 4) }),
        command("CI-05", "installation-1", 5, { installation: installation("consented", 5) }),
        command("CI-06", "installation-1", 6, { installation: installation("enabled", 6) }),
      ],
      [
        command("CI-01", "installation-1", 1, { installation: installation("registered", 1) }),
        command("CI-03", "installation-1", 2, { installation: installation("pending_consent", 2) }),
        command("CI-04", "installation-1", 3, { installation: installation("consented", 3) }),
        command("CI-05", "installation-1", 4, { installation: installation("consented", 4) }),
        command("CI-07", "installation-1", 5, {
          installation: installation("verification_failed", 5),
        }),
        command("CI-08", "installation-1", 6, { installation: installation("disabled", 6) }),
        command("CI-09", "installation-1", 7, {}),
      ],
    ] as const;

    const byOperation = new Map<
      string,
      ReturnType<typeof prepareConfigurationArtifactTransition>
    >();
    for (const group of groups) {
      for (const prepared of prepareSequence(group))
        byOperation.set(prepared.artifact.operationId, prepared);
    }
    expect([...byOperation]).toHaveLength(23);
    expect([...byOperation.keys()].sort()).toEqual(
      Execution.ConfigurationOperationCatalogV1.map(({ id }) => id).sort(),
    );

    for (const [operationId, prepared] of byOperation) {
      expect(prepared.append.batch.events).toHaveLength(1);
      const event = requireValue(prepared.append.batch.events[0], "prepared event is missing");
      const snapshotRef = event.payload.configurationSnapshotRef;
      const recordBlob = requireValue(prepared.artifacts[0], "configuration artifact is missing");
      expect(snapshotRef).toEqual({
        version: "content-blob-ref-v1",
        digest: recordBlob.hash.slice("sha256:".length),
        byteLength: recordBlob.bytes.byteLength,
        mediaType: "application/json",
      });
      const rebuilt = JSON.parse(new TextDecoder().decode(recordBlob.bytes));
      expect(rebuilt.operationId).toBe(operationId);
      expect(rebuilt.payload).toEqual(prepared.artifact.payload);
      expect(rebuilt.payload.configurationSnapshotRef).toBeUndefined();
      expect(Object.isFrozen(prepared.artifact)).toBe(true);
      expect(envelope(prepared, 1).event.eventType).toBe(event.eventType);
      expect(prepared.artifacts).toHaveLength(1);
    }
  });

  test("rejects a configuration snapshot reference that does not match canonical bytes", () => {
    const actor = {
      id: "actor-1",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    } as const;
    const valid = command("AI-01", actor.id, 1, { identity: actor });
    expect(() =>
      prepareConfigurationArtifactTransition({
        ...valid,
        payload: {
          ...valid.payload,
          configurationSnapshotRef: {
            ...valid.payload.configurationSnapshotRef,
            byteLength: valid.payload.configurationSnapshotRef.byteLength + 1,
          },
        },
      }),
    ).toThrow("configuration_snapshot_mismatch");
    expect(() =>
      prepareConfigurationArtifactTransition({
        ...valid,
        payload: {
          ...valid.payload,
          configurationSnapshotRef: {
            ...valid.payload.configurationSnapshotRef,
            digest: "f".repeat(64),
          },
        },
      }),
    ).toThrow("configuration_snapshot_mismatch");
  });

  test("rejects caller-shaped history, post-terminal mutation, and illegal connector edges", () => {
    const actor = {
      id: "actor-1",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    } as const;
    const created = command("AI-01", actor.id, 1, { identity: actor });
    expect(() =>
      prepareConfigurationArtifactTransition(command("AI-02", actor.id, 2, { identity: actor }), {
        priorRecordCount: 1,
        priorSnapshotRef: created.payload.configurationSnapshotRef,
        priorOperationIds: [],
      }),
    ).toThrow("previous_operation_history_mismatch");

    const retired = command("AI-03", actor.id, 2, {});
    expect(() =>
      prepareConfigurationArtifactTransition(command("AI-02", actor.id, 3, { identity: actor }), {
        priorRecordCount: 2,
        priorSnapshotRef: retired.payload.configurationSnapshotRef,
        priorOperationIds: ["AI-01", "AI-03"],
      }),
    ).toThrow("illegal_configuration_lifecycle");

    const registered = command("CI-01", "installation-1", 1, {
      installation: installation("registered", 1),
    });
    expect(() =>
      prepareConfigurationArtifactTransition(
        command("CI-04", "installation-1", 2, {
          installation: installation("consented", 2),
        }),
        {
          priorRecordCount: 1,
          priorSnapshotRef: registered.payload.configurationSnapshotRef,
          priorOperationIds: ["CI-01"],
        },
      ),
    ).toThrow("illegal_configuration_lifecycle");
  });

  test("rebuilds authority projections and rejects non-monotonic record versions", () => {
    const reducer = createAuthorityReducer();
    const actor = {
      id: "actor-1",
      kind: "human",
      trustTier: "owner",
      relationship: "owner",
    } as const;
    const sequence = prepareSequence([
      command("AI-01", actor.id, 1, { identity: actor }),
      command("AI-02", actor.id, 2, { identity: { ...actor, displayName: "Owner" } }),
      command("AI-03", actor.id, 3, {}),
    ]);
    const rebuilt = sequence.reduce(
      (state, item) =>
        reducer.reduce(
          state,
          item.artifact,
          requireValue(item.artifacts.at(-1), "configuration artifact is missing").hash,
        ),
      reducer.initialState,
    );
    expect(rebuilt.actorIdentities).toEqual({});
    const update = requireValue(sequence[1], "authority update is missing");
    expect(() => reducer.reduce(reducer.initialState, update.artifact)).toThrow("version conflict");
  });

  test("rebuilds connector state and derives actor plus endpoint in the same reducer call", () => {
    const reducer = createConnectorArtifactReducer();
    const prepared = prepareSequence([
      command("CI-01", "installation-1", 1, { installation: installation("registered", 1) }),
      command("CI-02", "installation-1", 2, { installation: installation("registered", 2) }),
      command("CI-03", "installation-1", 3, { installation: installation("pending_consent", 3) }),
      command("CI-04", "installation-1", 4, { installation: installation("consented", 4) }),
      command("CI-05", "installation-1", 5, { installation: installation("consented", 5) }),
      command("CI-06", "installation-1", 6, { installation: installation("enabled", 6) }),
    ]);
    const rebuilt = prepared.reduce(
      (state, item) =>
        reducer.reduce(
          state,
          item.artifact,
          requireValue(item.artifacts[0], "configuration artifact is missing").hash,
        ),
      reducer.initialState,
    );
    expect(rebuilt.connectorInstallations["installation-1"]?.recordVersion).toBe(6);
    expect(rebuilt.connectorActors["connector:endpoint-1"]?.metadata).toMatchObject({
      connectorInstallationId: "installation-1",
      status: "enabled",
    });
    expect(rebuilt.connectorEndpoints["connector:endpoint-1"]).toMatchObject({
      actorId: "connector:endpoint-1",
      externalId: "installation-1",
    });
    expect(prepared.every((item) => item.append.batch.events.length === 1)).toBe(true);
  });
});
