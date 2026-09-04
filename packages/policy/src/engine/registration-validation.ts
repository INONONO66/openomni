/**
 * NOTE: product composition maintains an
 * intentional duplicate of this registration boundary, pinned to the single
 * `dispatch.action.pre` point and surfacing its own error taxonomy
 * (`DispatchPolicyRegistrationError`). It delegates final acceptance to
 * `engine.register()` (this file), so validation added here also guards that
 * path — but keep the two boundaries in sync deliberately; they must not
 * drift apart silently.
 */
import { NamedError, Policy } from "@openomni/protocol";
import { z } from "zod";
import type {
  RuntimePolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyEngineMiddlewareGeneric,
} from "./types";
import { captureFrozenArray } from "./array-snapshot";
import { snapshotCanonicalBindings } from "./registration-snapshot";

const PolicyRegistrationErrorCode = z.enum([
  "invalid_registration_kind",
  "invalid_canonical_registration",
  "empty_point_ids",
  "duplicate_point_id",
  "unknown_point_id",
  "empty_effect_capabilities",
  "missing_effect_capabilities",
  "unbound_effect_capabilities",
  "duplicate_effect_capability",
  "disallowed_effect_capability",
  "empty_scope_agent_type",
  "async_policy_callback",
]);
type PolicyRegistrationErrorCode = z.infer<typeof PolicyRegistrationErrorCode>;

const PolicyRegistrationErrorData = z.object({
  message: z.string(),
  code: PolicyRegistrationErrorCode,
  registrationName: z.string(),
  pointId: z.string().optional(),
  effectType: z.string().optional(),
});
const PolicyRegistrationErrorBase = NamedError.create(
  "PolicyRegistrationError",
  PolicyRegistrationErrorData,
);

type PolicyRegistrationErrorOptions = Omit<z.input<typeof PolicyRegistrationErrorData>, "message">;

export class PolicyRegistrationError extends PolicyRegistrationErrorBase {
  constructor(options: PolicyRegistrationErrorOptions) {
    const detail = [options.pointId, options.effectType].filter(
      (value): value is string => value !== undefined,
    );
    super({
      ...options,
      message: `Invalid policy registration "${options.registrationName}": ${options.code}${
        detail.length > 0 ? ` (${detail.join(", ")})` : ""
      }`,
    });
  }

  get code(): PolicyRegistrationErrorCode {
    return this.data.code;
  }
  get registrationName(): string {
    return this.data.registrationName;
  }
  get pointId(): string | undefined {
    return this.data.pointId;
  }
  get effectType(): string | undefined {
    return this.data.effectType;
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

const canonicalMetadataSchema = Policy.Definition;

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
): value is RuntimePolicyRegistrationGeneric<TCtx>["fn"] {
  return typeof value === "function";
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}

/**
 * Direct registrations are contractually synchronous; only the factory lane
 * retains the Promise-capable runtime shape (agent compaction seam). The type
 * surface already rejects async callbacks at compile time, but `register()`
 * is a public runtime API reachable from plain JavaScript, so the direct lane
 * is also enforced here: an `async function` is refused eagerly at
 * registration, and a sync function returning a thenable is refused at call
 * time — thrown, never awaited, so a smuggled async verdict can neither allow
 * nor deny and the point's fail policy decides deterministically.
 */
function guardSynchronousCallback<TCtx extends GenericPolicyContext>(
  name: string,
  fn: RuntimePolicyRegistrationGeneric<TCtx>["fn"],
): RuntimePolicyRegistrationGeneric<TCtx>["fn"] {
  if (fn.constructor.name === "AsyncFunction") {
    throw registrationError(name, "async_policy_callback");
  }
  return (ctx) => {
    const decision = fn(ctx);
    if (isThenable(decision)) throw registrationError(name, "async_policy_callback");
    return decision;
  };
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
  lane: "direct" | "factory",
): RuntimePolicyRegistrationGeneric<TCtx> {
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
  // An empty agentType array is rejected fail-closed: it is the classic
  // config-filter-yielded-[] footgun, and both plausible readings are wrong —
  // "matches everyone" silently widens the policy, "matches no one" silently
  // disables it. Scope to everything by omitting `agentType`, never by
  // emptying it.
  if (scope?.agentType !== undefined && scope.agentType.length === 0) {
    throw registrationError(name, "empty_scope_agent_type");
  }
  const trusted = Object.freeze({
    kind: "point",
    name: metadata.data.name,
    priority: metadata.data.priority,
    pointIds,
    effectCapabilities,
    ...(scope === undefined ? {} : { scope }),
    ...(metadata.data.failPolicy === undefined ? {} : { failPolicy: metadata.data.failPolicy }),
    fn: lane === "direct" ? guardSynchronousCallback(name, fields.fn) : fields.fn,
  } satisfies RuntimePolicyRegistrationGeneric<TCtx>);
  return trusted;
}

export function prepareRegistrationBoundary<TCtx extends GenericPolicyContext>(
  registration: PolicyEngineMiddlewareGeneric<TCtx>,
): RuntimePolicyRegistrationGeneric<TCtx> {
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
    return prepareCanonicalRegistration<TCtx>(
      created,
      readClassificationFields(created),
      "factory",
    );
  }
  return prepareCanonicalRegistration<TCtx>(registration, classification, "direct");
}
