import { Policy } from "@openomni/protocol";
import { captureFrozenArray } from "./array-snapshot";
import type { PolicyPointId } from "./types";

type SnapshotErrorCode =
  | "invalid_canonical_registration"
  | "empty_point_ids"
  | "duplicate_point_id"
  | "unknown_point_id"
  | "empty_effect_capabilities"
  | "missing_effect_capabilities"
  | "unbound_effect_capabilities"
  | "duplicate_effect_capability"
  | "disallowed_effect_capability";

interface SnapshotErrorDetails {
  readonly pointId?: string;
  readonly effectType?: string;
}

type SnapshotFailure = (code: SnapshotErrorCode, details?: SnapshotErrorDetails) => never;

export interface CanonicalBindingSnapshot {
  readonly pointIds: readonly PolicyPointId[];
  readonly effectCapabilities: Readonly<
    Partial<Record<PolicyPointId, readonly Policy.PolicyEffectType[]>>
  >;
}

function isPolicyPointId(value: string): value is PolicyPointId {
  return Object.getOwnPropertyDescriptor(Policy.PolicyPoint.Registry, value) !== undefined;
}

function isPolicyEffectType(value: string): value is Policy.PolicyEffectType {
  return Policy.PolicyEffectType.safeParse(value).success;
}

function snapshotEffectCapabilityStrings(
  value: object,
  fail: SnapshotFailure,
): Readonly<Record<string, readonly string[]>> {
  const capabilities: Record<string, readonly string[]> = {};
  for (const pointId of Object.keys(value)) {
    const captured = captureFrozenArray(Reflect.get(value, pointId));
    if (!captured.success) {
      fail("invalid_canonical_registration", { pointId });
    }
    const effects: string[] = [];
    for (const effect of captured.value) {
      if (typeof effect !== "string") {
        fail("invalid_canonical_registration", { pointId });
      }
      effects.push(effect);
    }
    capabilities[pointId] = Object.freeze(effects);
  }
  return Object.freeze(capabilities);
}

function snapshotPointIds(value: unknown, fail: SnapshotFailure): readonly PolicyPointId[] {
  const captured = captureFrozenArray(value);
  if (!captured.success) fail("invalid_canonical_registration");
  const pointIds: string[] = [];
  for (const pointId of captured.value) {
    if (typeof pointId !== "string") fail("invalid_canonical_registration");
    pointIds.push(pointId);
  }
  if (pointIds.length === 0) fail("empty_point_ids");
  if (new Set(pointIds).size !== pointIds.length) fail("duplicate_point_id");

  if (!pointIds.every(isPolicyPointId)) {
    const pointId = pointIds.find((value) => !isPolicyPointId(value));
    fail("unknown_point_id", pointId === undefined ? {} : { pointId });
  }
  return Object.freeze(pointIds);
}

function snapshotEffectCapabilities(
  pointIds: readonly PolicyPointId[],
  rawCapabilities: Readonly<Record<string, readonly string[]>>,
  fail: SnapshotFailure,
): CanonicalBindingSnapshot["effectCapabilities"] {
  const capabilityPointIds = Object.keys(rawCapabilities);
  if (capabilityPointIds.length === 0) fail("empty_effect_capabilities");
  for (const pointId of pointIds) {
    if (Object.getOwnPropertyDescriptor(rawCapabilities, pointId) === undefined) {
      fail("missing_effect_capabilities", { pointId });
    }
  }

  const capabilities: Partial<Record<PolicyPointId, readonly Policy.PolicyEffectType[]>> = {};
  for (const pointId of capabilityPointIds) {
    if (!isPolicyPointId(pointId)) fail("unknown_point_id", { pointId });
    if (!pointIds.includes(pointId)) fail("unbound_effect_capabilities", { pointId });
    const rawEffects = rawCapabilities[pointId];
    if (rawEffects === undefined) fail("missing_effect_capabilities", { pointId });
    if (new Set(rawEffects).size !== rawEffects.length) {
      fail("duplicate_effect_capability", { pointId });
    }

    if (!rawEffects.every(isPolicyEffectType)) {
      const effectType = rawEffects.find((value) => !isPolicyEffectType(value));
      fail(
        "disallowed_effect_capability",
        effectType === undefined ? { pointId } : { pointId, effectType },
      );
    }
    const effectType = rawEffects.find(
      (value) => !Policy.PolicyPoint.Registry[pointId].allowedEffects.includes(value),
    );
    if (effectType !== undefined) {
      fail("disallowed_effect_capability", { pointId, effectType });
    }
    capabilities[pointId] = rawEffects;
  }
  return Object.freeze(capabilities);
}

export function snapshotCanonicalBindings(
  pointIdsValue: unknown,
  effectCapabilitiesValue: object,
  fail: SnapshotFailure,
): CanonicalBindingSnapshot {
  const rawCapabilities = snapshotEffectCapabilityStrings(effectCapabilitiesValue, fail);
  const pointIds = snapshotPointIds(pointIdsValue, fail);
  return {
    pointIds,
    effectCapabilities: snapshotEffectCapabilities(pointIds, rawCapabilities, fail),
  };
}
