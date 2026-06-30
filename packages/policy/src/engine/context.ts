import type { AuditDispatchContextGeneric, GenericPolicyContext } from "./types";

export function immutableSnapshot<TCtx extends GenericPolicyContext>(
  value: AuditDispatchContextGeneric<TCtx>,
): Readonly<AuditDispatchContextGeneric<TCtx>> {
  const snapshot = {
    ...value,
    ...(value.toolInput !== undefined && { toolInput: cloneRecord(value.toolInput) }),
    ...(isPlainRecord(value.usage) && { usage: cloneRecord(value.usage) }),
    ...(value.toolLabels !== undefined && { toolLabels: [...value.toolLabels] }),
    ...(value.messages !== undefined && { messages: [...value.messages] }),
    ...(value.traceContext !== undefined && {
      traceContext: Object.freeze({ ...value.traceContext }),
    }),
    ...(value.labels !== undefined && {
      labels: value.labels.map((entry) => Object.freeze({ ...entry })),
    }),
  };

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
