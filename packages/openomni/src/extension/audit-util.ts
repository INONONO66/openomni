const MAX_AUDIT_TEXT_LENGTH = 256;

export function actorKind(actor: Record<string, unknown>): string {
  return typeof actor.kind === "string" ? truncateAuditText(actor.kind) : "unknown";
}

export function actorLabel(actor: Record<string, unknown>): string {
  const kind = typeof actor.kind === "string" ? actor.kind : undefined;
  const id = typeof actor.id === "string" ? actor.id : undefined;
  if (kind !== undefined && id !== undefined) {
    return truncateAuditText(`${kind}:${id}`);
  }
  if (id !== undefined) {
    return truncateAuditText(id);
  }

  return truncateAuditText(stableStringify(actor));
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (seen.has(value)) {
    return JSON.stringify("[Circular]");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function truncateAuditText(value: string): string {
  return value.length <= MAX_AUDIT_TEXT_LENGTH ? value : value.slice(0, MAX_AUDIT_TEXT_LENGTH);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
