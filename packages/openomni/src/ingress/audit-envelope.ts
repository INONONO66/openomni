import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

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

const auditSequences = new Map<string, number>();

export function createIngressAudit(sessionId: string, scope: string) {
  return {
    append(
      name: string,
      payload: Record<string, unknown>,
      parentActionId?: string,
    ): IngressAuditEvent {
      const sequence = (auditSequences.get(sessionId) ?? 0) + 1;
      auditSequences.set(sessionId, sequence);
      const actionId = `${sessionId}:${scope}:${name}:${sequence}`;

      Bus.publish(Operational.Info, {
        traceId: sessionId,
        sessionId,
        time: Date.now(),
        component: scope,
        msg: name,
        context: {
          audit: {
            actionId,
            ...(parentActionId !== undefined && { parentActionId }),
            sequence,
            payload,
          },
        },
      });

      return { actionId };
    },
  };
}
