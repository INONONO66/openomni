import { createAuditLog } from "@openomni/session";

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

export function createIngressAudit(sessionId: string, scope: string) {
  return createAuditLog(sessionId, scope);
}
