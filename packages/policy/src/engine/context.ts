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

export function immutablePointSnapshot<TCtx extends GenericPolicyContext>(
  value: Readonly<AuditDispatchContextGeneric<TCtx>>,
  added: Readonly<{ readonly pointId: PolicyPointId; readonly timing: Policy.Timing }>,
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

function cloneRecord(record: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const clone: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    clone[key] = cloneValue(value);
  }

  return Object.freeze(clone);
}

function cloneArray(values: readonly unknown[]): readonly unknown[] {
  return Object.freeze(values.map(cloneValue));
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return cloneArray(value);
  if (isPlainRecord(value)) return cloneRecord(value);
  return value;
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
