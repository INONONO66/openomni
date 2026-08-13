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
 * Rejected, surfacing as `policy.input_invalid`: function and symbol values,
 * cycles, nested proxies, and values `structuredClone` preserves but that are
 * not plain records or arrays (Date, Map, Set, typed arrays, RegExp).
 *
 * Three shapes survive that the name "immutable snapshot" might suggest do not,
 * all inherited from `structuredClone` and unchanged by #606:
 *   - a *top-level* transparent proxy, flattened by the spread below before
 *     `structuredClone` ever sees it (only nested proxies are rejected);
 *   - symbol-keyed properties, silently dropped rather than rejected;
 *   - a nested class instance, cloned into a plain record.
 *
 * The one deliberate exception is the caller's event emitter, carried through
 * by reference.
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
 *
 * Values are read directly rather than through property descriptors, so an
 * accessor-defined `traceContext` reaches the audit record instead of leaving
 * `publishComposedDecision` to drop the event for want of a trace id. Unlike
 * the full snapshot's spread, `Reflect.get` also observes non-enumerable and
 * inherited properties, so this path can capture strictly more, never less.
 *
 * One snapshot covers the whole set; a single unsafe field falls back to
 * per-field capture so it cannot suppress the others.
 */
export function auditCorrelationContext(
  ctx: object,
  pointId: PolicyPointId,
  timing: Policy.Timing,
): Readonly<
  Record<string, unknown> & { readonly pointId: PolicyPointId; readonly timing: Policy.Timing }
> {
  const present: Record<string, unknown> = {};
  for (const key of AUDIT_CORRELATION_KEYS) {
    try {
      const value = Reflect.get(ctx, key);
      if (value !== undefined) present[key] = value;
    } catch {
      // A throwing accessor drops its own field, never the rest.
    }
  }

  const combined = immutablePointSnapshot(present, {});
  const fields = combined.success ? combined.value : capturePerField(present);
  return Object.freeze({ ...fields, pointId, timing });
}

function capturePerField(present: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(present)) {
    const captured = immutablePointSnapshot({ [key]: value }, {});
    if (captured.success) Object.assign(fields, captured.value);
  }
  return fields;
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
