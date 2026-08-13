import { Operational } from "@openomni/protocol";
import { Bus, newSpanId } from "@openomni/telemetry";

const TEXT_SUMMARY_LIMIT = 240;

export interface IngressAuditEvent {
  readonly actionId: string;
}

export interface TextSummary {
  readonly text: string;
  readonly length: number;
  readonly truncated: boolean;
}

export function summarizeText(text: string): TextSummary {
  return {
    text: text.length > TEXT_SUMMARY_LIMIT ? text.slice(0, TEXT_SUMMARY_LIMIT) : text,
    length: text.length,
    truncated: text.length > TEXT_SUMMARY_LIMIT,
  };
}

/**
 * Ingress action trail.
 *
 * Each `append` returns its id so the next call can name it as a parent — that
 * is a span tree, and it now uses W3C span ids instead of `Date.now()` plus
 * `Math.random()` strings, so an exporter can reconstruct it.
 *
 * This lives in `openomni` rather than the storage package because it always
 * belonged here: `AuditLog` sat in `packages/session` under a name promising
 * the ledger while publishing to the lossy observation bus (#606). The trail
 * is ingress's own, and the honest name says so.
 */
export function createIngressAudit(sessionId: string, component: string) {
  return {
    append(
      action: string,
      payload: Record<string, unknown>,
      parentSpanId?: string,
    ): IngressAuditEvent {
      const spanId = newSpanId();
      Bus.publish(Operational.Info, {
        traceId: sessionId,
        sessionId,
        time: Date.now(),
        component,
        msg: action,
        context: {
          audit: {
            spanId,
            ...(parentSpanId === undefined ? {} : { parentSpanId }),
            payload,
          },
        },
      });
      return { actionId: spanId };
    },
  };
}
