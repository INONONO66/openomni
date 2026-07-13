import { Policy } from "@openomni/protocol";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyPointId,
} from "./types";

type PolicyRegistrationErrorCode =
  | "invalid_registration_kind"
  | "invalid_canonical_registration"
  | "empty_point_ids"
  | "duplicate_point_id"
  | "unknown_point_id"
  | "empty_effect_capabilities"
  | "missing_effect_capabilities"
  | "unbound_effect_capabilities"
  | "duplicate_effect_capability"
  | "disallowed_effect_capability";

interface PolicyRegistrationErrorOptions {
  readonly code: PolicyRegistrationErrorCode;
  readonly registrationName: string;
  readonly pointId?: string;
  readonly effectType?: string;
}

export class PolicyRegistrationError extends Error {
  readonly code: PolicyRegistrationErrorCode;
  readonly registrationName: string;
  readonly pointId?: string;
  readonly effectType?: string;

  constructor(options: PolicyRegistrationErrorOptions) {
    const detail = [options.pointId, options.effectType].filter(
      (value): value is string => value !== undefined,
    );
    super(
      `Invalid policy registration "${options.registrationName}": ${options.code}${
        detail.length > 0 ? ` (${detail.join(", ")})` : ""
      }`,
    );
    this.name = "PolicyRegistrationError";
    this.code = options.code;
    this.registrationName = options.registrationName;
    if (options.pointId !== undefined) this.pointId = options.pointId;
    if (options.effectType !== undefined) this.effectType = options.effectType;
  }
}

function registrationError(
  registrationName: string,
  code: PolicyRegistrationErrorCode,
  details: { readonly pointId?: string; readonly effectType?: string } = {},
): PolicyRegistrationError {
  return new PolicyRegistrationError({ registrationName, code, ...details });
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const canonicalMetadataSchema = Policy.Definition.omit({ timing: true });

function registrationName(registration: object): string {
  const name = Reflect.get(registration, "name");
  return typeof name === "string" ? name : "<unknown>";
}

function hasValidCanonicalMetadata(registration: object): boolean {
  const propagate = Reflect.get(registration, "propagate");
  return (
    canonicalMetadataSchema.safeParse(registration).success &&
    typeof Reflect.get(registration, "fn") === "function" &&
    (propagate === undefined || typeof propagate === "boolean")
  );
}

export function validateRegistrationBoundary(registration: unknown): void {
  if (!isObject(registration)) {
    throw registrationError("<unknown>", "invalid_canonical_registration");
  }
  const name = registrationName(registration);
  if (!Reflect.has(registration, "kind")) {
    if (Reflect.has(registration, "pointIds") || Reflect.has(registration, "effectCapabilities")) {
      throw registrationError(name, "invalid_canonical_registration");
    }
    return;
  }
  if (Reflect.get(registration, "kind") !== "point") {
    throw registrationError(name, "invalid_registration_kind");
  }
  if (!hasValidCanonicalMetadata(registration)) {
    throw registrationError(name, "invalid_canonical_registration");
  }

  const pointIds = Reflect.get(registration, "pointIds");
  const effectCapabilities = Reflect.get(registration, "effectCapabilities");
  if (
    !Array.isArray(pointIds) ||
    !pointIds.every((pointId) => typeof pointId === "string") ||
    !isObject(effectCapabilities)
  ) {
    throw registrationError(name, "invalid_canonical_registration");
  }
  for (const pointId of Object.keys(effectCapabilities)) {
    const effects = Reflect.get(effectCapabilities, pointId);
    if (!Array.isArray(effects) || !effects.every((effect) => typeof effect === "string")) {
      throw registrationError(name, "invalid_canonical_registration", { pointId });
    }
  }
}

function isPolicyPointId(value: string): value is PolicyPointId {
  return Object.getOwnPropertyDescriptor(Policy.PolicyPoint.Registry, value) !== undefined;
}

function validatePointBindings<TCtx extends GenericPolicyContext>(
  registration: CanonicalPolicyRegistrationGeneric<TCtx>,
): void {
  if (registration.pointIds.length === 0) {
    throw registrationError(registration.name, "empty_point_ids");
  }
  if (new Set(registration.pointIds).size !== registration.pointIds.length) {
    throw registrationError(registration.name, "duplicate_point_id");
  }

  for (const pointId of registration.pointIds) {
    if (!isPolicyPointId(pointId)) {
      throw registrationError(registration.name, "unknown_point_id", { pointId });
    }
  }
}

function validateEffectCapabilities<TCtx extends GenericPolicyContext>(
  registration: CanonicalPolicyRegistrationGeneric<TCtx>,
): void {
  const capabilityPointIds = Object.keys(registration.effectCapabilities);
  if (capabilityPointIds.length === 0) {
    throw registrationError(registration.name, "empty_effect_capabilities");
  }

  for (const pointId of registration.pointIds) {
    if (Object.getOwnPropertyDescriptor(registration.effectCapabilities, pointId) === undefined) {
      throw registrationError(registration.name, "missing_effect_capabilities", { pointId });
    }
  }

  for (const pointId of capabilityPointIds) {
    if (!isPolicyPointId(pointId)) {
      throw registrationError(registration.name, "unknown_point_id", { pointId });
    }
    if (!registration.pointIds.includes(pointId)) {
      throw registrationError(registration.name, "unbound_effect_capabilities", { pointId });
    }

    const effects = registration.effectCapabilities[pointId];
    if (effects === undefined) {
      throw registrationError(registration.name, "missing_effect_capabilities", { pointId });
    }
    if (new Set(effects).size !== effects.length) {
      throw registrationError(registration.name, "duplicate_effect_capability", { pointId });
    }
    const allowedEffects = Policy.PolicyPoint.Registry[pointId].allowedEffects;
    for (const effectType of effects) {
      if (!allowedEffects.includes(effectType)) {
        throw registrationError(registration.name, "disallowed_effect_capability", {
          pointId,
          effectType,
        });
      }
    }
  }
}

export function snapshotCanonicalRegistration<TCtx extends GenericPolicyContext>(
  registration: CanonicalPolicyRegistrationGeneric<TCtx>,
): CanonicalPolicyRegistrationGeneric<TCtx> {
  validatePointBindings(registration);
  validateEffectCapabilities(registration);

  const effectCapabilities: Partial<Record<PolicyPointId, readonly Policy.PolicyEffectType[]>> = {};
  for (const pointId of registration.pointIds) {
    const effects = registration.effectCapabilities[pointId];
    if (effects === undefined) {
      throw registrationError(registration.name, "missing_effect_capabilities", { pointId });
    }
    effectCapabilities[pointId] = Object.freeze([...effects]);
  }

  let scope: Policy.Scope | undefined;
  if (registration.scope !== undefined) {
    scope = {
      ...registration.scope,
      ...(registration.scope.agentType === undefined
        ? {}
        : { agentType: [...registration.scope.agentType] }),
    };
    if (scope.agentType !== undefined) Object.freeze(scope.agentType);
    Object.freeze(scope);
  }

  return Object.freeze({
    ...registration,
    pointIds: Object.freeze([...registration.pointIds]),
    effectCapabilities: Object.freeze(effectCapabilities),
    ...(scope === undefined ? {} : { scope }),
  });
}
