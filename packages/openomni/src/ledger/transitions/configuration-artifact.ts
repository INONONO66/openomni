import { createHash } from "node:crypto";
import { Execution, Ledger } from "@openomni/protocol";
import type { KernelTransitionCommandV1 } from "../ports.js";

const EVENT_BY_OPERATION = Object.freeze({
  "AF-01": "artifact.referenced.v1",
  "AI-01": "actor.identity_registered.v1",
  "AI-02": "actor.identity_revised.v1",
  "AI-03": "actor.identity_retired.v1",
  "AE-01": "actor.endpoint_bound.v1",
  "AE-02": "actor.endpoint_rebound.v1",
  "AE-03": "actor.endpoint_unbound.v1",
  "BL-01": "authority.blacklist_created.v1",
  "BL-02": "authority.blacklist_revised.v1",
  "BL-03": "authority.blacklist_revoked.v1",
  "BL-04": "authority.blacklist_expired.v1",
  "CG-01": "authority.channel_grant_created.v1",
  "CG-02": "authority.channel_grant_revised.v1",
  "CG-03": "authority.channel_grant_revoked.v1",
  "CI-01": "connector.installation_registered.v1",
  "CI-02": "connector.definition_revised.v1",
  "CI-03": "connector.consent_requested.v1",
  "CI-04": "connector.consent_granted.v1",
  "CI-05": "connector.verification_requested.v1",
  "CI-06": "connector.verified.v1",
  "CI-07": "connector.verification_failed.v1",
  "CI-08": "connector.disabled.v1",
  "CI-09": "connector.uninstalled.v1",
} satisfies Record<string, Ledger.NativeEventTypeV1>);

export type ConfigurationOperationIdV1 = keyof typeof EVENT_BY_OPERATION;

type ConfigurationArtifactPayloadV1 =
  Execution.ConfigurationOperationPayloadV1 extends infer Payload
    ? Payload extends { readonly configurationSnapshotRef: Execution.ContentBlobRefV1 }
      ? Omit<Payload, "configurationSnapshotRef">
      : never
    : never;

export interface ConfigurationArtifactV1 {
  readonly version: "configuration-artifact-v1";
  readonly operationId: ConfigurationOperationIdV1;
  readonly command: string;
  readonly owner: Ledger.OwnerV1;
  readonly subjectId: string;
  readonly recordVersion: number;
  readonly occurredAtDbMs: number;
  /** The complete reducer input, excluding its self-referential immutable blob reference. */
  readonly payload: ConfigurationArtifactPayloadV1;
}

export interface PreparedConfigurationArtifactV1 {
  readonly hash: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

export interface ConfigurationArtifactTransitionContextV1 {
  /** Writer-read immutable history facts; callers cannot supply a competing prior snapshot. */
  readonly priorRecordCount?: number;
  readonly priorSnapshotRef?: Execution.ContentBlobRefV1;
  /** Ordered writer-read operations for this subject; must exactly match priorRecordCount. */
  readonly priorOperationIds?: readonly ConfigurationOperationIdV1[];
}

export interface PreparedConfigurationArtifactTransitionV1 {
  readonly append: Ledger.AppendBatchRequestV1;
  /** These blobs must be inserted in the same writer transaction as append. */
  readonly artifacts: readonly PreparedConfigurationArtifactV1[];
  readonly artifact: ConfigurationArtifactV1;
}

export class ConfigurationArtifactTransitionError extends Error {
  readonly code = "transition_forbidden" as const;

  constructor(readonly reason: string) {
    super(`configuration transition rejected: ${reason}`);
    this.name = "ConfigurationArtifactTransitionError";
  }
}

export function isConfigurationOperationId(value: string): value is ConfigurationOperationIdV1 {
  return Object.getOwnPropertyDescriptor(EVENT_BY_OPERATION, value) !== undefined;
}

/** Prepares all AF/AI/AE/BL/CG/CI operations as one event plus immutable reducer input. */
export function prepareConfigurationArtifactTransition(
  input: KernelTransitionCommandV1,
  context: ConfigurationArtifactTransitionContextV1 = {},
): PreparedConfigurationArtifactTransitionV1 {
  const command = Execution.KernelTransitionCommandV1.parse(input);
  const transitionId = String(command.transitionId);
  if (!isConfigurationOperationId(transitionId)) {
    throw new ConfigurationArtifactTransitionError("not_configuration_operation");
  }
  if (command.payload.version !== "configuration-operation-payload-v1") {
    throw new ConfigurationArtifactTransitionError("invalid_configuration_payload");
  }

  const payload = command.payload;
  assertRecordIdentity(transitionId, payload);
  const expectedVersion = (context.priorRecordCount ?? 0) + 1;
  if (payload.recordVersion !== expectedVersion) {
    throw new ConfigurationArtifactTransitionError("record_version_conflict");
  }
  if ((context.priorRecordCount ?? 0) > 0 && context.priorSnapshotRef === undefined) {
    throw new ConfigurationArtifactTransitionError("previous_artifact_missing");
  }
  const priorOperationIds = context.priorOperationIds ?? [];
  if (priorOperationIds.length !== (context.priorRecordCount ?? 0)) {
    throw new ConfigurationArtifactTransitionError("previous_operation_history_mismatch");
  }
  assertConfigurationLifecycle(transitionId, priorOperationIds);

  const { configurationSnapshotRef, ...artifactPayload } = payload;
  const artifact = deepFreeze({
    version: "configuration-artifact-v1",
    operationId: transitionId,
    command: command.command,
    owner: payload.owner,
    subjectId: payload.subjectId,
    recordVersion: payload.recordVersion,
    occurredAtDbMs: payload.occurredAtDbMs,
    payload: artifactPayload,
  } satisfies ConfigurationArtifactV1);
  const bytes = new TextEncoder().encode(canonicalJson(artifact));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    configurationSnapshotRef.digest !== digest ||
    configurationSnapshotRef.byteLength !== bytes.byteLength
  ) {
    throw new ConfigurationArtifactTransitionError("configuration_snapshot_mismatch");
  }
  const eventType = EVENT_BY_OPERATION[transitionId];
  const event = Ledger.EventV1.parse({
    version: "ledger-event-v1",
    eventId: `${command.requestId}:${transitionId}:1`,
    eventType,
    eventVersion: 1,
    owner: payload.owner,
    payload: {
      version: "native-event-payload-v1",
      eventType,
      subjectId: payload.subjectId,
      occurredAtDbMs: payload.occurredAtDbMs,
      configurationSnapshotRef,
    },
    provenance: {
      version: "native-event-provenance-v1",
      principalId: command.identity.principalId,
      requestId: command.requestId,
    },
  });
  const append = Ledger.AppendBatchRequestV1.parse({
    version: "ledger-append-batch-request-v1",
    requestId: command.requestId,
    requestHash: command.requestHash,
    principalId: command.identity.principalId,
    expectedHead: command.expectedHead,
    batch: {
      version: "ledger-batch-v1",
      batchId: `${command.requestId}:${transitionId}`,
      owner: payload.owner,
      events: [event],
    },
  });

  const artifacts: PreparedConfigurationArtifactV1[] = [
    Object.freeze({ hash: `sha256:${digest}`, bytes }),
  ];

  return Object.freeze({ append, artifacts: Object.freeze(artifacts), artifact });
}

function assertRecordIdentity(
  operationId: ConfigurationOperationIdV1,
  payload: Execution.ConfigurationOperationPayloadV1,
): void {
  const id =
    "artifactId" in payload
      ? payload.artifactId
      : "identity" in payload
        ? payload.identity.id
        : "endpoint" in payload
          ? payload.endpoint.id
          : "entry" in payload
            ? payload.entry.id
            : "grant" in payload
              ? payload.grant.id
              : "installation" in payload
                ? payload.installation.id
                : undefined;
  if (id !== undefined && id !== payload.subjectId) {
    throw new ConfigurationArtifactTransitionError("subject_identity_mismatch");
  }
  const isCreation = operationId.endsWith("-01");
  if (isCreation !== (payload.recordVersion === 1)) {
    throw new ConfigurationArtifactTransitionError("creation_version_mismatch");
  }
}

function assertConfigurationLifecycle(
  operationId: ConfigurationOperationIdV1,
  priorOperationIds: readonly ConfigurationOperationIdV1[],
): void {
  const previous = priorOperationIds.at(-1);
  const requirePrevious = (allowed: readonly ConfigurationOperationIdV1[]): void => {
    if (previous === undefined || !allowed.includes(previous)) {
      throw new ConfigurationArtifactTransitionError("illegal_configuration_lifecycle");
    }
  };

  if (operationId.endsWith("-01")) {
    if (priorOperationIds.length !== 0) {
      throw new ConfigurationArtifactTransitionError("configuration_record_already_exists");
    }
    return;
  }
  if (priorOperationIds.length === 0) {
    throw new ConfigurationArtifactTransitionError("configuration_record_missing");
  }
  const family = operationId.slice(0, 2);
  if (priorOperationIds.some((priorOperationId) => priorOperationId.slice(0, 2) !== family)) {
    throw new ConfigurationArtifactTransitionError("previous_operation_history_mismatch");
  }

  switch (operationId) {
    case "AI-02":
    case "AI-03":
      requirePrevious(["AI-01", "AI-02"]);
      return;
    case "AE-02":
    case "AE-03":
      requirePrevious(["AE-01", "AE-02"]);
      return;
    case "BL-02":
    case "BL-03":
    case "BL-04":
      requirePrevious(["BL-01", "BL-02"]);
      return;
    case "CG-02":
    case "CG-03":
      requirePrevious(["CG-01", "CG-02"]);
      return;
    case "CI-02":
      requirePrevious(["CI-01", "CI-02"]);
      return;
    case "CI-03":
      requirePrevious(["CI-01", "CI-02"]);
      return;
    case "CI-04":
      requirePrevious(["CI-03"]);
      return;
    case "CI-05":
      requirePrevious(["CI-04", "CI-07"]);
      return;
    case "CI-06":
    case "CI-07":
      requirePrevious(["CI-05"]);
      return;
    case "CI-08":
      requirePrevious(["CI-06", "CI-07"]);
      return;
    case "CI-09":
      if (previous === "CI-09") {
        throw new ConfigurationArtifactTransitionError("configuration_record_terminal");
      }
      return;
    default:
      throw new ConfigurationArtifactTransitionError("illegal_configuration_lifecycle");
  }
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
