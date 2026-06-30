import type { AuditDispatchContextGeneric, GenericPolicyContext } from "./engine-types";

export function immutableSnapshot<TCtx extends GenericPolicyContext>(
  value: AuditDispatchContextGeneric<TCtx>,
): Readonly<AuditDispatchContextGeneric<TCtx>> {
  // steps and usage are agent-loop fields absent from GenericPolicyContext;
  // access via Record widening for safe duck-typing when present at runtime.
  const wide = value as AuditDispatchContextGeneric<TCtx> & Record<string, unknown>;

  const snapshot = {
    ...value,
    ...(Array.isArray(wide.steps) && { steps: [...(wide.steps as unknown[])] }),
    ...(wide.usage !== null &&
      wide.usage !== undefined &&
      typeof wide.usage === "object" && { usage: Object.freeze({ ...(wide.usage as object) }) }),
    ...(value.toolInput !== undefined && { toolInput: cloneRecord(value.toolInput) }),
    ...(value.toolLabels !== undefined && { toolLabels: [...value.toolLabels] }),
    ...(value.messages !== undefined && { messages: [...value.messages] }),
    ...(value.traceContext !== undefined && {
      traceContext: Object.freeze({ ...value.traceContext }),
    }),
    ...(value.labels !== undefined && {
      labels: value.labels.map((entry) => Object.freeze({ ...entry })),
    }),
  } as AuditDispatchContextGeneric<TCtx>;

  const snap = snapshot as AuditDispatchContextGeneric<TCtx> & Record<string, unknown>;
  if (Array.isArray(snap.steps)) Object.freeze(snap.steps);
  if (snapshot.toolLabels !== undefined) Object.freeze(snapshot.toolLabels);
  if (snapshot.messages !== undefined) Object.freeze(snapshot.messages);
  if (snapshot.labels !== undefined) Object.freeze(snapshot.labels);

  return Object.freeze(snapshot);
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
