import type { Bus } from "@openomni/telemetry";

interface SafeParseSuccess {
  readonly success: true;
  readonly data: unknown;
}

interface SafeParseFailure {
  readonly success: false;
}

type SafeParseResult = SafeParseSuccess | SafeParseFailure;

interface SafeParseSchema {
  safeParse(value: unknown): unknown;
}

export function parsePayload(event: Bus.PublishedDescriptor, payload: unknown): unknown {
  const schema = toSafeParseSchema(event.schema);
  if (schema === undefined) {
    return payload;
  }

  try {
    const result = schema.safeParse(payload);
    return isSafeParseResult(result) && result.success ? result.data : payload;
  } catch {
    return payload;
  }
}

function toSafeParseSchema(schema: unknown): SafeParseSchema | undefined {
  if (schema === null || typeof schema !== "object") {
    return undefined;
  }

  const candidate = schema as { readonly safeParse?: unknown };
  return typeof candidate.safeParse === "function" ? (candidate as SafeParseSchema) : undefined;
}

function isSafeParseResult(value: unknown): value is SafeParseResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "success" in value &&
    typeof value.success === "boolean"
  );
}
