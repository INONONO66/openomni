import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AUDIT_LOG_PATH = join(homedir(), ".openomni", "audit.jsonl");
const AUDIT_DIR = join(homedir(), ".openomni");

export type AuditEntry = {
  ts: number;
  tool: string;
  allowed: boolean;
  reason: string;
  tier: string;
  runId?: string;
  sessionId?: string;
};

export function logPermissionDecision(entry: AuditEntry): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Audit log failure must not block tool execution
  }
}
