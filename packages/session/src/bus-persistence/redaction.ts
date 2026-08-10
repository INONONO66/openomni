import { toRecord } from "./record-fields.js";

const sensitiveKeyPattern =
  /authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?key/i;
const rawBodyKeyPattern =
  /^(args|command|content|err|error|input|messages|msg|newString|oldString|output|payload|prompt|systemPrompt|text)$/i;

export function redactForPersistence(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[redacted]";
    seen.add(value);
    return value.map((item) => redactForPersistence(item, seen));
  }
  const record = toRecord(value);
  if (!record) return value;
  if (seen.has(record)) return "[redacted]";
  seen.add(record);

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (sensitiveKeyPattern.test(key)) {
      redacted[key] = "[redacted]";
    } else if (rawBodyKeyPattern.test(key)) {
      redacted[key] = summarizeValue(item);
    } else {
      redacted[key] = redactForPersistence(item, seen);
    }
  }
  return redacted;
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return { type: "string", length: value.length };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  const record = toRecord(value);
  if (record) return { type: "object", keys: Object.keys(record).sort() };
  return value;
}
