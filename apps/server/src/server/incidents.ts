import type { BoundarySanitizer, SanitizedValue } from "@openomni/llm/credential-runtime";

export interface RedactedIncidentV1 {
  readonly version: "redacted-incident-v1";
  readonly authoritative: false;
  readonly incidentId: string;
  readonly occurredAt: number;
  readonly component: string;
  readonly summary: string;
  readonly data?: SanitizedValue;
}

export interface IncidentSink {
  report(input: {
    readonly component: string;
    readonly summary: string;
    readonly data?: unknown;
  }): void;
  dispose(): void;
}

/** Lossy diagnostics only. The sink cannot acknowledge or mutate authoritative state. */
export function createIncidentSink(options: {
  readonly sanitizer: BoundarySanitizer;
  readonly publish: (incident: RedactedIncidentV1) => void;
  readonly now?: () => number;
  readonly incidentId?: () => string;
}): IncidentSink {
  let disposed = false;
  const sink: IncidentSink = {
    report(input) {
      if (disposed) throw new Error("Incident sink is disposed");
      const incident: RedactedIncidentV1 = Object.freeze({
        version: "redacted-incident-v1",
        authoritative: false,
        incidentId: options.incidentId?.() ?? crypto.randomUUID(),
        occurredAt: options.now?.() ?? Date.now(),
        component: options.sanitizer.sanitizeText("incident.component", input.component),
        summary: options.sanitizer.sanitizeText("incident.summary", input.summary),
        ...(input.data === undefined
          ? {}
          : { data: options.sanitizer.sanitizeValue("incident.data", input.data) }),
      });
      try {
        options.publish(incident);
      } catch {
        // Incident delivery is deliberately lossy and cannot affect authoritative outcomes.
      }
    },
    dispose() {
      disposed = true;
    },
  };
  return Object.freeze(sink);
}
