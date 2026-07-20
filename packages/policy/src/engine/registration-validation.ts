import { Policy } from "@openomni/protocol";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyEngineRegistrationGeneric,
  PolicyRegistrationGeneric,
} from "./types";
import { captureFrozenArray } from "./array-snapshot";
import { snapshotCanonicalBindings } from "./registration-snapshot";

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
const policyTimingValues: ReadonlySet<string> = new Set(Object.values(Policy.Timing));

function registrationName(name: unknown): string {
  return typeof name === "string" ? name : "<unknown>";
}

interface ClassificationFields {
  readonly kind: unknown;
  readonly name: unknown;
  readonly pointIds: unknown;
  readonly effectCapabilities: unknown;
}

interface SharedMetadataFields {
  readonly priority: unknown;
  readonly scope: unknown;
  readonly failPolicy: unknown;
  readonly fn: unknown;
  readonly propagate: unknown;
}

function readClassificationFields(registration: object): ClassificationFields {
  return {
    kind: Reflect.get(registration, "kind"),
    name: Reflect.get(registration, "name"),
    pointIds: Reflect.get(registration, "pointIds"),
    effectCapabilities: Reflect.get(registration, "effectCapabilities"),
  };
}

function readSharedMetadataFields(registration: object): SharedMetadataFields {
  return {
    priority: Reflect.get(registration, "priority"),
    scope: Reflect.get(registration, "scope"),
    failPolicy: Reflect.get(registration, "failPolicy"),
    fn: Reflect.get(registration, "fn"),
    propagate: Reflect.get(registration, "propagate"),
  };
}

function isCanonicalPolicyFunction<TCtx extends GenericPolicyContext>(
  value: unknown,
): value is CanonicalPolicyRegistrationGeneric<TCtx>["fn"] {
  return typeof value === "function";
}

function isLegacyPolicyFunction<TCtx extends GenericPolicyContext>(
  value: unknown,
): value is PolicyRegistrationGeneric<TCtx>["fn"] {
  return typeof value === "function";
}

function isPolicyTiming(value: unknown): value is Policy.Timing {
  return typeof value === "string" && policyTimingValues.has(value);
}

type LegacyTimingSnapshot =
  | { readonly success: true; readonly value: Policy.Timing | Policy.Timing[] }
  | { readonly success: false };

function captureLegacyTiming(value: unknown): LegacyTimingSnapshot {
  if (isPolicyTiming(value)) return { success: true, value };
  const captured = captureFrozenArray(value);
  if (!captured.success || !captured.value.every(isPolicyTiming)) return { success: false };
  return { success: true, value: captured.value };
}

function captureScope(value: unknown): unknown {
  if (!isObject(value)) return value;
  const agentType = Reflect.get(value, "agentType");
  if (agentType === undefined) return {};
  const captured = captureFrozenArray(agentType);
  return { agentType: captured.success ? captured.value : agentType };
}

function frozenScope(scope: Policy.Scope | undefined): Policy.Scope | undefined {
  if (scope === undefined) return undefined;
  const snapshot = {
    ...scope,
    ...(scope.agentType === undefined ? {} : { agentType: [...scope.agentType] }),
  };
  if (snapshot.agentType !== undefined) Object.freeze(snapshot.agentType);
  return Object.freeze(snapshot);
}

export type PreparedPolicyRegistration<TCtx extends GenericPolicyContext> =
  | {
      readonly kind: "legacy";
      readonly registration: PolicyRegistrationGeneric<TCtx>;
    }
  | {
      readonly kind: "point";
      readonly registration: CanonicalPolicyRegistrationGeneric<TCtx>;
    };

function prepareCanonicalRegistration<TCtx extends GenericPolicyContext>(
  registration: object,
  classification: ClassificationFields,
): PreparedPolicyRegistration<TCtx> {
  const name = registrationName(classification.name);
  if (classification.kind === undefined) {
    throw registrationError(name, "invalid_canonical_registration");
  }
  if (classification.kind !== "point") {
    throw registrationError(name, "invalid_registration_kind");
  }
  const fields = { ...classification, ...readSharedMetadataFields(registration) };
  const metadata = canonicalMetadataSchema.safeParse({
    ...fields,
    scope: captureScope(fields.scope),
  });
  if (
    !metadata.success ||
    !isCanonicalPolicyFunction<TCtx>(fields.fn) ||
    (fields.propagate !== undefined && typeof fields.propagate !== "boolean")
  ) {
    throw registrationError(name, "invalid_canonical_registration");
  }
  if (!isObject(fields.effectCapabilities)) {
    throw registrationError(name, "invalid_canonical_registration");
  }
  const { pointIds, effectCapabilities } = snapshotCanonicalBindings(
    fields.pointIds,
    fields.effectCapabilities,
    (code, details = {}) => {
      throw registrationError(name, code, details);
    },
  );
  const scope = frozenScope(metadata.data.scope);
  const trusted = Object.freeze({
    kind: "point",
    name: metadata.data.name,
    priority: metadata.data.priority,
    pointIds,
    effectCapabilities,
    ...(scope === undefined ? {} : { scope }),
    ...(metadata.data.failPolicy === undefined ? {} : { failPolicy: metadata.data.failPolicy }),
    fn: fields.fn,
    ...(fields.propagate === undefined ? {} : { propagate: fields.propagate }),
  } satisfies CanonicalPolicyRegistrationGeneric<TCtx>);
  return { kind: "point", registration: trusted };
}

function prepareLegacyRegistration<TCtx extends GenericPolicyContext>(
  registration: object,
  classification: ClassificationFields,
): PreparedPolicyRegistration<TCtx> {
  const fields = {
    name: classification.name,
    timing: Reflect.get(registration, "timing"),
    ...readSharedMetadataFields(registration),
  };
  const name = registrationName(fields.name);
  const timing = captureLegacyTiming(fields.timing);
  const scopeResult =
    fields.scope === undefined ? undefined : Policy.Scope.safeParse(captureScope(fields.scope));
  const failPolicyResult =
    fields.failPolicy === undefined ? undefined : Policy.FailPolicy.safeParse(fields.failPolicy);
  if (
    typeof fields.name !== "string" ||
    !timing.success ||
    typeof fields.priority !== "number" ||
    scopeResult?.success === false ||
    failPolicyResult?.success === false ||
    !isLegacyPolicyFunction<TCtx>(fields.fn) ||
    (fields.propagate !== undefined && typeof fields.propagate !== "boolean")
  ) {
    throw registrationError(name, "invalid_canonical_registration");
  }
  const scope = scopeResult?.success === true ? frozenScope(scopeResult.data) : undefined;
  const failPolicy = failPolicyResult?.success === true ? failPolicyResult.data : undefined;
  const trusted = Object.freeze({
    name: fields.name,
    timing: timing.value,
    priority: fields.priority,
    ...(scope === undefined ? {} : { scope }),
    ...(failPolicy === undefined ? {} : { failPolicy }),
    fn: fields.fn,
    ...(fields.propagate === undefined ? {} : { propagate: fields.propagate }),
  } satisfies PolicyRegistrationGeneric<TCtx>);
  return { kind: "legacy", registration: trusted };
}

export function prepareRegistrationBoundary<TCtx extends GenericPolicyContext>(
  registration: PolicyEngineRegistrationGeneric<TCtx>,
): PreparedPolicyRegistration<TCtx> {
  if (!isObject(registration)) {
    throw registrationError("<unknown>", "invalid_canonical_registration");
  }
  const classification = readClassificationFields(registration);
  const hasCanonicalFields =
    classification.kind !== undefined ||
    classification.pointIds !== undefined ||
    classification.effectCapabilities !== undefined;
  return hasCanonicalFields
    ? prepareCanonicalRegistration<TCtx>(registration, classification)
    : prepareLegacyRegistration<TCtx>(registration, classification);
}
