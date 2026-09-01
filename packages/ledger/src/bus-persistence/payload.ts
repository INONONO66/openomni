import { BusEvent } from "@openomni/protocol";
import type { Bus } from "@openomni/telemetry";

export type PayloadStatus = "valid" | "invalid" | "parse_failed";

export interface ParsedPayload {
  readonly value: Bus.Data;
  readonly status: PayloadStatus;
  readonly diagnostic?: string;
}

export function parsePayload(
  event: { readonly schema: unknown },
  payload: Bus.Data,
): ParsedPayload {
  let parser: ((value: Bus.Data) => unknown) | undefined;
  try {
    if (event.schema !== null && typeof event.schema === "object") {
      const candidate = Reflect.get(event.schema, "safeParse");
      if (typeof candidate === "function") parser = candidate.bind(event.schema);
    }
  } catch {
    return { value: payload, status: "parse_failed", diagnostic: "schema parser threw" };
  }

  if (!parser) {
    return { value: payload, status: "parse_failed", diagnostic: "schema parser unavailable" };
  }

  try {
    const result = parser(payload);
    if (result === null || typeof result !== "object") {
      return { value: payload, status: "parse_failed", diagnostic: "schema parser result invalid" };
    }
    const success = Reflect.get(result, "success");
    if (success === false) {
      return { value: payload, status: "invalid", diagnostic: "schema validation failed" };
    }
    if (success !== true) {
      return { value: payload, status: "parse_failed", diagnostic: "schema parser result invalid" };
    }
    return {
      value: preserveMetadata(payload, toBusData(Reflect.get(result, "data"))),
      status: "valid",
    };
  } catch {
    return { value: payload, status: "parse_failed", diagnostic: "schema parser threw" };
  }
}

function toBusData(value: unknown): Bus.Data {
  if (value === null) return null;
  if (typeof value === "object" || typeof value === "function") return value;
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (typeof value === "symbol") return value;
  return undefined;
}

function preserveMetadata(payload: Bus.Data, normalized: Bus.Data): Bus.Data {
  const metadata = BusEvent.Metadata.safeParse(payload);
  if (!metadata.success) return normalized;
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }
  return { ...normalized, ...metadata.data };
}
