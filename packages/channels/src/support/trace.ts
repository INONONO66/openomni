import { traceIdFromUuid } from "@openomni/protocol";

/** Channel-driver trace origin; entropy stays in the consuming runtime package. */
export function newTraceId(): string {
  return traceIdFromUuid(crypto.randomUUID());
}
