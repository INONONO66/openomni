import { BusEvent } from "@openomni/protocol";
import type { Bus } from "@openomni/telemetry";

export type PayloadStatus = "valid" | "invalid" | "parse_failed";

export interface ParsedPayload {
  readonly value: Bus.Data;
  readonly status: PayloadStatus;
  readonly diagnostic?: string;
}

export function parsePayload(
  event: Bus.PublishedDescriptor,
  payload: Bus.Data,
): ParsedPayload {
  try {
    const result = event.schema.safeParse(payload);
    return result.success
      ? { value: preserveMetadata(payload, result.data), status: "valid" }
      : { value: payload, status: "invalid", diagnostic: "schema validation failed" };
  } catch {
    return { value: payload, status: "parse_failed", diagnostic: "schema parser threw" };
  }
}

function preserveMetadata(payload: Bus.Data, normalized: Bus.Data): Bus.Data {
  const metadata = BusEvent.Metadata.safeParse(payload);
  if (!metadata.success) return normalized;
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }
  return { ...normalized, ...metadata.data };
}
