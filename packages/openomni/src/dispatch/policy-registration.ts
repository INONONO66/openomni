/**
 * NOTE: this file is an intentional duplicate of the generic registration
 * boundary in `packages/policy/src/engine/registration-validation.ts`,
 * specialized for the single `dispatch.action.pre` point and surfacing its
 * own error taxonomy (`DispatchPolicyRegistrationError`) at the dispatch
 * trust boundary. `registerDispatchPolicy` still delegates final acceptance
 * to `engine.register()`, so the generic boundary's validation (including
 * `empty_scope_agent_type`) applies here too — but keep the two files in
 * sync deliberately; they must not drift apart silently.
 */
import { Policy } from "@openomni/protocol";
import type {
  CanonicalPolicyRegistrationGeneric,
  PolicyEngineInstanceGeneric,
} from "@openomni/policy";
import type { DispatchPolicyContext } from "./policy.js";

const DISPATCH_POINT_ID = "dispatch.action.pre" as const;
const canonicalMetadataSchema = Policy.Definition.omit({ timing: true });

type DispatchPointId = typeof DISPATCH_POINT_ID;

export type DispatchPolicyRegistration = Omit<
  CanonicalPolicyRegistrationGeneric<DispatchPolicyContext>,
  "pointIds" | "effectCapabilities"
> & {
  readonly pointIds: readonly [DispatchPointId];
  readonly effectCapabilities: Readonly<
    Record<DispatchPointId, readonly Policy.PolicyEffectType[]>
  >;
};

export type DispatchPolicyRegistrationErrorCode =
  | "legacy_policy_not_supported"
  | "unsupported_policy_point"
  | "invalid_policy_registration";

export class DispatchPolicyRegistrationError extends Error {
  readonly code: DispatchPolicyRegistrationErrorCode;
  readonly registrationName: string;

  constructor(
    code: DispatchPolicyRegistrationErrorCode,
    registrationName: string,
    cause?: unknown,
  ) {
    super(`Invalid dispatch policy "${registrationName}": ${code}`, { cause });
    this.name = "DispatchPolicyRegistrationError";
    this.code = code;
    this.registrationName = registrationName;
  }
}

interface CanonicalFields {
  readonly name: unknown;
  readonly pointIds: unknown;
  readonly effectCapabilities: unknown;
  readonly priority: unknown;
  readonly scope: unknown;
  readonly failPolicy: unknown;
  readonly fn: unknown;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticName(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "<unknown>";
}

function readCanonicalFields(value: object, name: unknown): CanonicalFields {
  return {
    name,
    pointIds: Reflect.get(value, "pointIds"),
    effectCapabilities: Reflect.get(value, "effectCapabilities"),
    priority: Reflect.get(value, "priority"),
    scope: Reflect.get(value, "scope"),
    failPolicy: Reflect.get(value, "failPolicy"),
    fn: Reflect.get(value, "fn"),
  };
}

function snapshotUnknownArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Reflect.get(value, "length");
  if (!Number.isSafeInteger(length) || length < 0) return undefined;

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) {
    snapshot.push(Reflect.get(value, index));
  }
  return snapshot;
}

function snapshotPointIds(value: unknown, name: string): readonly [DispatchPointId] {
  const pointIds = snapshotUnknownArray(value);
  if (pointIds?.length !== 1 || pointIds[0] !== DISPATCH_POINT_ID) {
    throw new DispatchPolicyRegistrationError("unsupported_policy_point", name);
  }
  return Object.freeze([DISPATCH_POINT_ID] as const);
}

function snapshotEffectCapabilities(
  value: unknown,
  name: string,
): DispatchPolicyRegistration["effectCapabilities"] {
  if (!isRecord(value)) {
    throw new DispatchPolicyRegistrationError("invalid_policy_registration", name);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== DISPATCH_POINT_ID) {
    throw new DispatchPolicyRegistrationError("invalid_policy_registration", name);
  }

  const rawEffects = snapshotUnknownArray(Reflect.get(value, DISPATCH_POINT_ID));
  if (rawEffects === undefined) {
    throw new DispatchPolicyRegistrationError("invalid_policy_registration", name);
  }
  const effects: Policy.PolicyEffectType[] = [];
  for (const rawEffect of rawEffects) {
    const parsed = Policy.PolicyEffectType.safeParse(rawEffect);
    if (!parsed.success) {
      throw new DispatchPolicyRegistrationError("invalid_policy_registration", name);
    }
    effects.push(parsed.data);
  }
  return Object.freeze({ [DISPATCH_POINT_ID]: Object.freeze(effects) });
}

function snapshotScope(value: unknown, name: string): Policy.Scope | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new DispatchPolicyRegistrationError("invalid_policy_registration", name);
  }
  const rawAgentTypes = Reflect.get(value, "agentType");
  if (rawAgentTypes === undefined) return Object.freeze({});

  const agentTypes = snapshotUnknownArray(rawAgentTypes);
  if (agentTypes === undefined || !agentTypes.every((agentType) => typeof agentType === "string")) {
    throw new DispatchPolicyRegistrationError("invalid_policy_registration", name);
  }
  const scope: Policy.Scope = { agentType: [...agentTypes] };
  Object.freeze(scope.agentType);
  return Object.freeze(scope);
}

function isCanonicalPolicyFunction(value: unknown): value is DispatchPolicyRegistration["fn"] {
  return typeof value === "function";
}

function inspectDispatchPolicy(value: unknown): {
  readonly registration: DispatchPolicyRegistration;
  readonly registrationName: string;
} {
  let name = "<unknown>";
  try {
    if (!isRecord(value)) {
      throw new DispatchPolicyRegistrationError("legacy_policy_not_supported", name);
    }
    const rawName = Reflect.get(value, "name");
    name = diagnosticName(rawName);
    if (Reflect.get(value, "kind") !== "point") {
      throw new DispatchPolicyRegistrationError("legacy_policy_not_supported", name);
    }
    const fields = readCanonicalFields(value, rawName);
    const pointIds = snapshotPointIds(fields.pointIds, name);
    const effectCapabilities = snapshotEffectCapabilities(fields.effectCapabilities, name);
    const scope = snapshotScope(fields.scope, name);
    const metadata = canonicalMetadataSchema.safeParse({
      name: fields.name,
      priority: fields.priority,
      scope,
      failPolicy: fields.failPolicy,
    });
    if (!metadata.success || !isCanonicalPolicyFunction(fields.fn)) {
      throw new DispatchPolicyRegistrationError("invalid_policy_registration", name);
    }
    const trusted = {
      kind: "point",
      name: metadata.data.name,
      pointIds,
      effectCapabilities,
      priority: metadata.data.priority,
      ...(scope === undefined ? {} : { scope }),
      ...(metadata.data.failPolicy === undefined ? {} : { failPolicy: metadata.data.failPolicy }),
      fn: fields.fn,
    } satisfies DispatchPolicyRegistration;
    return { registration: Object.freeze(trusted), registrationName: name };
  } catch (error) {
    if (error instanceof DispatchPolicyRegistrationError) throw error;
    throw new DispatchPolicyRegistrationError("invalid_policy_registration", name, error);
  }
}

export function registerDispatchPolicy(
  engine: PolicyEngineInstanceGeneric<DispatchPolicyContext>,
  value: unknown,
): void {
  const inspected = inspectDispatchPolicy(value);
  try {
    engine.register(inspected.registration);
  } catch (error) {
    if (error instanceof DispatchPolicyRegistrationError) throw error;
    throw new DispatchPolicyRegistrationError(
      "invalid_policy_registration",
      inspected.registrationName,
      error,
    );
  }
}
