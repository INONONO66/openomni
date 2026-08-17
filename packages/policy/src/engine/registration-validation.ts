import { Policy } from "@openomni/protocol";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyEngineMiddlewareGeneric,
} from "./types";
import { captureFrozenArray } from "./array-snapshot";
import { snapshotCanonicalBindings } from "./registration-snapshot";

type PolicyRegistrationErrorCode =
  | "invalid_registration_kind"
  | "legacy_timing_registration"
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
  };
}

function isCanonicalPolicyFunction<TCtx extends GenericPolicyContext>(
  value: unknown,
): value is CanonicalPolicyRegistrationGeneric<TCtx>["fn"] {
  return typeof value === "function";
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

function prepareCanonicalRegistration<TCtx extends GenericPolicyContext>(
  registration: object,
  classification: ClassificationFields,
): CanonicalPolicyRegistrationGeneric<TCtx> {
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
  if (!metadata.success || !isCanonicalPolicyFunction<TCtx>(fields.fn)) {
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
  } satisfies CanonicalPolicyRegistrationGeneric<TCtx>);
  return trusted;
}

export function prepareRegistrationBoundary<TCtx extends GenericPolicyContext>(
  registration: PolicyEngineMiddlewareGeneric<TCtx>,
): CanonicalPolicyRegistrationGeneric<TCtx> {
  if (!isObject(registration)) {
    throw registrationError("<unknown>", "invalid_canonical_registration");
  }
  const classification = readClassificationFields(registration);
  // A per-engine factory is instantiated HERE, once per engine — the engine
  // is built per run, so this is what scopes a stateful policy's closure
  // state to the run. The created registration then passes the same
  // validation boundary as a directly registered one.
  if (classification.kind === "factory") {
    const create = Reflect.get(registration, "create");
    if (typeof create !== "function") {
      throw registrationError(
        registrationName(classification.name),
        "invalid_canonical_registration",
      );
    }
    const created: unknown = Reflect.apply(create, registration, []);
    // No factory-of-factory: the created value must be a canonical point
    // registration, validated through the same boundary. `isObject` and the
    // classification reads below reject anything else fail-closed.
    if (!isObject(created)) {
      throw registrationError(
        registrationName(classification.name),
        "invalid_canonical_registration",
      );
    }
    return prepareCanonicalRegistration<TCtx>(created, readClassificationFields(created));
  }
  const hasCanonicalFields =
    classification.kind !== undefined ||
    classification.pointIds !== undefined ||
    classification.effectCapabilities !== undefined;
  if (!hasCanonicalFields) {
    // Fail-closed since #530: a timing-based (legacy) registration is
    // rejected outright instead of accepted-then-skipped at dispatch, which
    // would be a silent policy bypass.
    throw registrationError(registrationName(classification.name), "legacy_timing_registration");
  }
  return prepareCanonicalRegistration<TCtx>(registration, classification);
}
