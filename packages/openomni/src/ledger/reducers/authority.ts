import type { Actor } from "@openomni/protocol";
import type {
  ConfigurationArtifactV1,
  ConfigurationOperationIdV1,
} from "../transitions/configuration-artifact.js";

export interface VersionedAuthorityRecordV1<T> {
  readonly value: T;
  readonly recordVersion: number;
  readonly occurredAtDbMs: number;
  readonly artifactHash?: string;
}

export interface AuthorityProjectionStateV1 {
  readonly actorIdentities: Readonly<Record<string, VersionedAuthorityRecordV1<Actor.Identity>>>;
  readonly actorEndpoints: Readonly<Record<string, VersionedAuthorityRecordV1<Actor.Endpoint>>>;
  readonly blacklist: Readonly<Record<string, VersionedAuthorityRecordV1<Actor.BlacklistEntry>>>;
  readonly channelGrants: Readonly<Record<string, VersionedAuthorityRecordV1<Actor.ChannelGrant>>>;
}

export interface AuthorityReducerV1 {
  readonly initialState: AuthorityProjectionStateV1;
  reduce(
    state: AuthorityProjectionStateV1,
    artifact: ConfigurationArtifactV1,
    artifactHash?: string,
  ): AuthorityProjectionStateV1;
}

const AUTHORITY_OPERATIONS = new Set<ConfigurationOperationIdV1>([
  "AI-01",
  "AI-02",
  "AI-03",
  "AE-01",
  "AE-02",
  "AE-03",
  "BL-01",
  "BL-02",
  "BL-03",
  "BL-04",
  "CG-01",
  "CG-02",
  "CG-03",
]);

export function createAuthorityReducer(): AuthorityReducerV1 {
  const initialState = freezeState({
    actorIdentities: {},
    actorEndpoints: {},
    blacklist: {},
    channelGrants: {},
  });
  return Object.freeze({
    initialState,
    reduce: reduceAuthorityProjection,
  });
}

/** Pure reducer: identical ordered artifacts always produce byte-equivalent projection state. */
export function reduceAuthorityProjection(
  state: AuthorityProjectionStateV1,
  artifact: ConfigurationArtifactV1,
  artifactHash?: string,
): AuthorityProjectionStateV1 {
  if (!AUTHORITY_OPERATIONS.has(artifact.operationId)) return state;
  const payload = artifact.payload;
  const next = {
    actorIdentities: state.actorIdentities,
    actorEndpoints: state.actorEndpoints,
    blacklist: state.blacklist,
    channelGrants: state.channelGrants,
  };
  const record = <T>(value: T): VersionedAuthorityRecordV1<T> =>
    Object.freeze({
      value: deepFreeze(structuredClone(value)),
      recordVersion: artifact.recordVersion,
      occurredAtDbMs: artifact.occurredAtDbMs,
      ...(artifactHash === undefined ? {} : { artifactHash }),
    });

  switch (artifact.operationId) {
    case "AI-01":
    case "AI-02":
      if (!("identity" in payload)) throw invalidPayload(artifact.operationId);
      next.actorIdentities = replaceVersioned(
        state.actorIdentities,
        payload.identity.id,
        record(payload.identity),
      );
      break;
    case "AI-03":
      next.actorIdentities = removeVersioned(
        state.actorIdentities,
        artifact.subjectId,
        artifact.recordVersion,
      );
      break;
    case "AE-01":
    case "AE-02":
      if (!("endpoint" in payload)) throw invalidPayload(artifact.operationId);
      next.actorEndpoints = replaceVersioned(
        state.actorEndpoints,
        payload.endpoint.id,
        record(payload.endpoint),
      );
      break;
    case "AE-03":
      next.actorEndpoints = removeVersioned(
        state.actorEndpoints,
        artifact.subjectId,
        artifact.recordVersion,
      );
      break;
    case "BL-01":
    case "BL-02":
      if (!("entry" in payload)) throw invalidPayload(artifact.operationId);
      next.blacklist = replaceVersioned(state.blacklist, payload.entry.id, record(payload.entry));
      break;
    case "BL-03":
    case "BL-04":
      next.blacklist = removeVersioned(state.blacklist, artifact.subjectId, artifact.recordVersion);
      break;
    case "CG-01":
    case "CG-02":
      if (!("grant" in payload)) throw invalidPayload(artifact.operationId);
      next.channelGrants = replaceVersioned(
        state.channelGrants,
        payload.grant.id,
        record(payload.grant),
      );
      break;
    case "CG-03":
      next.channelGrants = removeVersioned(
        state.channelGrants,
        artifact.subjectId,
        artifact.recordVersion,
      );
      break;
  }
  return freezeState(next);
}

function replaceVersioned<T>(
  values: Readonly<Record<string, VersionedAuthorityRecordV1<T>>>,
  id: string,
  next: VersionedAuthorityRecordV1<T>,
): Readonly<Record<string, VersionedAuthorityRecordV1<T>>> {
  const current = values[id];
  if (next.recordVersion !== (current?.recordVersion ?? 0) + 1) throw versionConflict(id);
  return Object.freeze({ ...values, [id]: next });
}

function removeVersioned<T>(
  values: Readonly<Record<string, VersionedAuthorityRecordV1<T>>>,
  id: string,
  recordVersion: number,
): Readonly<Record<string, VersionedAuthorityRecordV1<T>>> {
  const current = values[id];
  if (current === undefined || recordVersion !== current.recordVersion + 1)
    throw versionConflict(id);
  const mutable = { ...values };
  delete mutable[id];
  return Object.freeze(mutable);
}

function freezeState(state: AuthorityProjectionStateV1): AuthorityProjectionStateV1 {
  return Object.freeze({
    actorIdentities: Object.freeze(state.actorIdentities),
    actorEndpoints: Object.freeze(state.actorEndpoints),
    blacklist: Object.freeze(state.blacklist),
    channelGrants: Object.freeze(state.channelGrants),
  });
}

function versionConflict(id: string): Error {
  return new Error(`authority projection version conflict: ${id}`);
}

function invalidPayload(operationId: string): Error {
  return new Error(`invalid authority artifact payload: ${operationId}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
