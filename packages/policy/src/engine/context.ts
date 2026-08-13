import type { Policy } from "@openomni/protocol";
import type {
  AuditDispatchContextGeneric,
  CanonicalAuditDispatchContextGeneric,
  GenericPolicyContext,
  PolicyPointId,
} from "./types";

type ImmutablePointSnapshot<TValue extends object> =
  | { readonly success: true; readonly value: Readonly<TValue> }
  | { readonly success: false };

/**
 * Copies a dispatch context into a frozen graph a policy cannot mutate.
 *
 * Only plain records, arrays, and primitives survive. Functions, symbols,
 * cycles, proxies, and exotic objects (Date, Map, typed arrays) fail the
 * snapshot, which the dispatcher reports as `policy.input_invalid`. The one
 * exception is the caller's event emitter, carried through by reference.
 *
 * `added` is applied after the clone, so the engine's own fields — the point
 * identity and the agent type that drove registration selection — are the ones
 * a policy observes, never a context getter's second answer.
 */
export function immutablePointSnapshot<TCtx extends GenericPolicyContext>(
  value: Readonly<AuditDispatchContextGeneric<TCtx>>,
  added: Readonly<{
    readonly pointId: PolicyPointId;
    readonly timing: Policy.Timing;
    readonly agentType?: string;
  }>,
): ImmutablePointSnapshot<CanonicalAuditDispatchContextGeneric<TCtx>>;
export function immutablePointSnapshot<TValue extends object, TAdded extends object>(
  value: TValue,
  added: TAdded,
): ImmutablePointSnapshot<TValue & TAdded>;
export function immutablePointSnapshot(
  value: object,
  added: object,
): ImmutablePointSnapshot<object> {
  try {
    if (!isPlainRecord(value)) return { success: false };
    const source = { ...value } as Record<string, unknown>;
    const eventEmitter = source.eventEmitter;
    const preservesEventEmitter =
      Object.getOwnPropertyDescriptor(source, "eventEmitter") !== undefined &&
      isEventEmitterLike(eventEmitter);
    if (preservesEventEmitter) delete source.eventEmitter;
    const snapshot = {
      ...structuredClone(source),
      ...added,
      ...(preservesEventEmitter && { eventEmitter }),
    };
    if (!freezePlainValue(snapshot, new WeakSet(), eventEmitter)) return { success: false };
    return { success: true, value: snapshot };
  } catch {
    return { success: false };
  }
}

/**
 * Correlation fields worth keeping on an audit record when the full context was
 * never materialized. Each is captured independently so one unsafe field cannot
 * suppress the rest.
 */
const AUDIT_CORRELATION_KEYS = [
  "traceContext",
  "sessionId",
  "runId",
  "resourceDescriptor",
  "toolName",
  "dispatchId",
  "correlation",
] as const;

/**
 * Audit context for a dispatch that never built a full snapshot — either the
 * snapshot failed, or the point carries no registration and materializing the
 * context would be pure cost.
 */
export function auditCorrelationContext(
  ctx: object,
  pointId: PolicyPointId,
  timing: Policy.Timing,
): Readonly<
  Record<string, unknown> & { readonly pointId: PolicyPointId; readonly timing: Policy.Timing }
> {
  const fields: Record<string, unknown> = {};
  for (const key of AUDIT_CORRELATION_KEYS) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(ctx, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const captured = immutablePointSnapshot({ [key]: descriptor.value }, {});
      if (captured.success) Object.assign(fields, captured.value);
    } catch {
      // Ignore unsafe getters and proxies; independently safe fields still land.
    }
  }
  return Object.freeze({ ...fields, pointId, timing });
}

function freezePlainValue(
  value: unknown,
  ancestors: WeakSet<object>,
  preservedValue?: unknown,
): boolean {
  if (value === preservedValue) return true;
  if (typeof value === "function" || typeof value === "symbol") return false;
  if (typeof value !== "object" || value === null) return true;
  if (ancestors.has(value)) return false;
  if (!Array.isArray(value) && !isPlainRecord(value)) return false;

  ancestors.add(value);
  for (const child of Object.values(value)) {
    if (!freezePlainValue(child, ancestors, preservedValue)) return false;
  }
  ancestors.delete(value);
  Object.freeze(value);
  return true;
}

function isEventEmitterLike(value: unknown): value is object {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "emit") === "function"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
