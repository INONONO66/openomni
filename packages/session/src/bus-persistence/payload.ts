import type { Bus } from "../bus/index.js";

interface SafeParseSuccess {
  readonly success: true;
  readonly data: unknown;
}

interface SafeParseFailure {
  readonly success: false;
}

type SafeParseResult = SafeParseSuccess | SafeParseFailure;

interface SafeParseSchema {
  safeParse(value: unknown): SafeParseResult;
}

export function parsePayload(event: Bus.PublishedDescriptor, payload: unknown): unknown {
  const schema = toSafeParseSchema(event.schema);
  if (schema === undefined) {
    return payload;
  }

  const result = schema.safeParse(payload);
  return result.success ? result.data : payload;
}

function toSafeParseSchema(schema: unknown): SafeParseSchema | undefined {
  if (schema === null || typeof schema !== "object") {
    return undefined;
  }

  const candidate = schema as { readonly safeParse?: unknown };
  return typeof candidate.safeParse === "function" ? (candidate as SafeParseSchema) : undefined;
}
