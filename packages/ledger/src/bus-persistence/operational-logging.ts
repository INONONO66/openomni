import { toRecord } from "./record-fields.js";
import { redactForPersistence } from "./redaction.js";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const operationalPrefix = "operational.";

export function writeOperationalToStdout(eventName: string, payload: unknown): void {
  if (!eventName.startsWith(operationalPrefix)) return;

  const level = eventName.slice(operationalPrefix.length).split(".", 1)[0] ?? "";
  if (!isLogLevel(level)) return;
  if (LOG_LEVELS[level] < LOG_LEVELS[getMinLogLevel()]) return;

  const rec = toRecord(payload);
  const ctx = rec ? toRecord(rec.context) : undefined;
  const redactedCtx = toRecord(redactForPersistence(ctx));
  const line = JSON.stringify({
    ...redactedCtx,
    ...correlationFields(rec),
    ts: rec?.time ?? Date.now(),
    level,
    pid: process.pid,
    component: rec?.component ?? "unknown",
    msg: rec?.msg ?? "",
  });
  process.stdout.write(`${line}\n`);
}

function correlationFields(
  record: Record<string, unknown> | undefined,
): Record<string, string | number> {
  if (record === undefined) return {};
  const fields = [
    "eventId",
    "traceId",
    "spanId",
    "parentSpanId",
    "sessionId",
    "runId",
    "actorId",
    "agentName",
    "componentId",
    "componentGeneration",
    "pluginName",
    "pluginVersion",
    "configRevision",
  ] as const;
  const kept: Record<string, string | number> = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" || typeof value === "number") kept[field] = value;
  }
  return kept;
}

function getMinLogLevel(): LogLevel {
  const env = process.env.OPENOMNI_LOG_LEVEL?.toLowerCase();
  return env && isLogLevel(env) ? env : "info";
}

function isLogLevel(value: string): value is LogLevel {
  return Object.keys(LOG_LEVELS).includes(value);
}
