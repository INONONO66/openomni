import type { Actor, AppConnector } from "@openomni/protocol";
import type { ConfigurationArtifactV1 } from "../transitions/configuration-artifact.js";

export interface ArtifactReferenceProjectionV1 {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly title: string;
  readonly recordVersion: number;
  readonly occurredAtDbMs: number;
  readonly configurationArtifactHash?: string;
}

export interface ConnectorInstallationProjectionV1 {
  readonly installation: AppConnector.Installation;
  readonly recordVersion: number;
  readonly occurredAtDbMs: number;
  readonly configurationArtifactHash?: string;
}

export interface ConnectorArtifactProjectionStateV1 {
  readonly artifactReferences: Readonly<Record<string, ArtifactReferenceProjectionV1>>;
  readonly connectorInstallations: Readonly<Record<string, ConnectorInstallationProjectionV1>>;
  /** Derived in the CI reducer transaction; no second actor transition is emitted. */
  readonly connectorActors: Readonly<Record<string, Actor.Identity>>;
  readonly connectorEndpoints: Readonly<Record<string, Actor.Endpoint>>;
}

export interface ConnectorArtifactReducerV1 {
  readonly initialState: ConnectorArtifactProjectionStateV1;
  reduce(
    state: ConnectorArtifactProjectionStateV1,
    artifact: ConfigurationArtifactV1,
    artifactHash?: string,
  ): ConnectorArtifactProjectionStateV1;
}

export function createConnectorArtifactReducer(): ConnectorArtifactReducerV1 {
  const initialState = freezeState({
    artifactReferences: {},
    connectorInstallations: {},
    connectorActors: {},
    connectorEndpoints: {},
  });
  return Object.freeze({ initialState, reduce: reduceConnectorArtifactProjection });
}

export function reduceConnectorArtifactProjection(
  state: ConnectorArtifactProjectionStateV1,
  artifact: ConfigurationArtifactV1,
  artifactHash?: string,
): ConnectorArtifactProjectionStateV1 {
  if (artifact.operationId === "AF-01") {
    if (!("artifactId" in artifact.payload)) throw invalidPayload(artifact.operationId);
    if (state.artifactReferences[artifact.payload.artifactId] !== undefined) {
      throw versionConflict(artifact.payload.artifactId);
    }
    const reference = Object.freeze({
      artifactId: artifact.payload.artifactId,
      contentHash: artifact.payload.contentRef.digest,
      byteLength: artifact.payload.contentRef.byteLength,
      mediaType: artifact.payload.contentRef.mediaType,
      title: artifact.payload.title,
      recordVersion: artifact.recordVersion,
      occurredAtDbMs: artifact.occurredAtDbMs,
      ...(artifactHash === undefined ? {} : { configurationArtifactHash: artifactHash }),
    });
    return freezeState({
      ...state,
      artifactReferences: { ...state.artifactReferences, [reference.artifactId]: reference },
    });
  }
  if (!artifact.operationId.startsWith("CI-")) return state;

  const installationId = artifact.subjectId;
  if (artifact.operationId === "CI-09") {
    const current = state.connectorInstallations[installationId];
    if (current === undefined || artifact.recordVersion !== current.recordVersion + 1) {
      throw versionConflict(installationId);
    }
    const connectorInstallations = without(state.connectorInstallations, installationId);
    const connectorActors = without(state.connectorActors, current.installation.endpointId);
    const connectorEndpoints = without(state.connectorEndpoints, current.installation.endpointId);
    return freezeState({
      ...state,
      connectorInstallations,
      connectorActors,
      connectorEndpoints,
    });
  }

  if (!("installation" in artifact.payload)) throw invalidPayload(artifact.operationId);
  const installation = deepFreeze(structuredClone(artifact.payload.installation));
  const current = state.connectorInstallations[installationId];
  if (artifact.recordVersion !== (current?.recordVersion ?? 0) + 1) {
    throw versionConflict(installationId);
  }
  if (current !== undefined && current.installation.endpointId !== installation.endpointId) {
    throw new Error(`connector endpoint identity is immutable: ${installationId}`);
  }
  assertLifecycleSnapshot(artifact.operationId, installation.status);

  const projected = Object.freeze({
    installation,
    recordVersion: artifact.recordVersion,
    occurredAtDbMs: artifact.occurredAtDbMs,
    ...(artifactHash === undefined ? {} : { configurationArtifactHash: artifactHash }),
  });
  const identity = deriveConnectorActor(installation);
  const endpoint = deriveConnectorEndpoint(installation);
  return freezeState({
    ...state,
    connectorInstallations: {
      ...state.connectorInstallations,
      [installationId]: projected,
    },
    connectorActors: { ...state.connectorActors, [identity.id]: identity },
    connectorEndpoints: { ...state.connectorEndpoints, [endpoint.id]: endpoint },
  });
}

export function deriveConnectorActor(installation: AppConnector.Installation): Actor.Identity {
  return deepFreeze({
    id: installation.endpointId,
    kind: "ai_agent",
    trustTier: "assigned_worker",
    relationship: "worker",
    displayName: installation.definition.name,
    metadata: {
      connectorInstallationId: installation.id,
      connectorId: installation.connectorId,
      connectorVersion: installation.connectorVersion,
      status: installation.status,
    },
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  });
}

export function deriveConnectorEndpoint(installation: AppConnector.Installation): Actor.Endpoint {
  return deepFreeze({
    id: installation.endpointId,
    actorId: installation.endpointId,
    channel: "connector",
    externalId: installation.id,
    displayName: installation.definition.name,
    metadata: {
      connectorId: installation.connectorId,
      connectorVersion: installation.connectorVersion,
      status: installation.status,
    },
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  });
}

function assertLifecycleSnapshot(
  operationId: string,
  status: AppConnector.InstallationStatus,
): void {
  const expected: Readonly<Record<string, AppConnector.InstallationStatus>> = {
    "CI-01": "registered",
    "CI-03": "pending_consent",
    "CI-04": "consented",
    "CI-06": "enabled",
    "CI-07": "verification_failed",
    "CI-08": "disabled",
  };
  const required = expected[operationId];
  if (required !== undefined && status !== required) {
    throw new Error(`connector lifecycle snapshot mismatch: ${operationId}`);
  }
}

function without<T>(values: Readonly<Record<string, T>>, id: string): Readonly<Record<string, T>> {
  const mutable = { ...values };
  delete mutable[id];
  return Object.freeze(mutable);
}

function freezeState(
  state: ConnectorArtifactProjectionStateV1,
): ConnectorArtifactProjectionStateV1 {
  return Object.freeze({
    artifactReferences: Object.freeze(state.artifactReferences),
    connectorInstallations: Object.freeze(state.connectorInstallations),
    connectorActors: Object.freeze(state.connectorActors),
    connectorEndpoints: Object.freeze(state.connectorEndpoints),
  });
}

function versionConflict(id: string): Error {
  return new Error(`connector/artifact projection version conflict: ${id}`);
}

function invalidPayload(operationId: string): Error {
  return new Error(`invalid connector/artifact payload: ${operationId}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
