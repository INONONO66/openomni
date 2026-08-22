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

export type PayloadStatus = "valid" | "invalid" | "parse_failed";

export interface ParsedPayload {
  readonly value: unknown;
  readonly status: PayloadStatus;
  readonly diagnostic?: string;
}

export function parsePayload(event: Bus.PublishedDescriptor, payload: unknown): ParsedPayload {
  const schema = toSafeParseSchema(event.schema);
  if (schema === undefined) {
    return { value: payload, status: "parse_failed", diagnostic: "schema parser unavailable" };
  }

  try {
    const result = schema.safeParse(payload);
    if (!isSafeParseResult(result)) {
      return { value: payload, status: "parse_failed", diagnostic: "schema parser result invalid" };
    }
    return result.success
      ? { value: result.data, status: "valid" }
      : { value: payload, status: "invalid", diagnostic: "schema validation failed" };
  } catch {
    return { value: payload, status: "parse_failed", diagnostic: "schema parser threw" };
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
