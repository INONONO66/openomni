import type { AppConnector, Execution, Token } from "@openomni/protocol";

type StructuredLogData = Record<string, unknown>;
type StructuredLogs = Extract<AppConnector.Logs, { kind: "jsonl" | "stream_json" }>;
type ToolStatus = NonNullable<NonNullable<Execution.LogEvent["toolCall"]>["status"]>;

type LogEventBase = Omit<Execution.LogEvent, "usage" | "toolCall">;

const tokenFieldMap = {
  inputTokens: ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "input"],
  outputTokens: [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "output",
  ],
  totalTokens: ["totalTokens", "total_tokens", "total"],
  reasoningTokens: ["reasoningTokens", "reasoning_tokens", "reasoning"],
  cacheReadTokens: ["cacheReadTokens", "cache_read_tokens", "cacheRead", "cache_read"],
  cacheWriteTokens: ["cacheWriteTokens", "cache_write_tokens", "cacheWrite", "cache_write"],
} satisfies Record<keyof Token.ExecutionUsage, readonly string[]>;

export function buildLocalCliLogEvent(
  logs: AppConnector.Logs,
  data: StructuredLogData,
  base: LogEventBase,
): Execution.LogEvent {
  if (logs.kind === "text") return base;
  return {
    ...base,
    ...withDefined("usage", extractTokenUsage(logs, data)),
    ...withDefined("toolCall", extractToolCall(logs, data)),
  };
}

export function aggregateLocalCliLogUsage(
  logs: AppConnector.Logs,
  events: readonly Execution.LogEvent[],
): Execution.Result["usage"] {
  if (logs.kind === "text" || logs.tokenUsageField === undefined) return undefined;
  const usages = events.map((event) => event.usage).filter((usage) => usage !== undefined);
  if (usages.length === 0) return undefined;
  if (logs.tokenUsageMode === "delta") return sumUsages(usages);
  return usages[usages.length - 1];
}

function extractTokenUsage(
  logs: StructuredLogs,
  data: StructuredLogData,
): Token.ExecutionUsage | undefined {
  if (logs.tokenUsageField === undefined) return undefined;
  const raw = data[logs.tokenUsageField];
  if (!isRecord(raw)) return undefined;

  const usage: Token.ExecutionUsage = {};
  for (const [targetField, sourceFields] of Object.entries(tokenFieldMap)) {
    const value = firstCount(raw, sourceFields);
    if (value !== undefined) {
      usage[targetField as keyof Token.ExecutionUsage] = value;
    }
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function extractToolCall(
  logs: StructuredLogs,
  data: StructuredLogData,
): Execution.LogEvent["toolCall"] {
  if (logs.toolCallField === undefined) return undefined;
  const raw = data[logs.toolCallField];
  if (!isRecord(raw)) return undefined;

  const tool = firstString(raw, ["tool", "name", "toolName", "tool_name"]);
  if (tool === undefined) return undefined;
  return {
    ...withDefined("id", firstString(raw, ["id", "toolCallId", "tool_call_id"])),
    tool,
    ...withDefined("status", normalizeToolStatus(firstString(raw, ["status", "state"]))),
    ...withDefined("input", recordValue(raw.input)),
    ...withDefined("output", raw.output),
  };
}

function sumUsages(usages: readonly Token.ExecutionUsage[]): Token.ExecutionUsage {
  const total: Token.ExecutionUsage = {};
  for (const usage of usages) {
    for (const field of Object.keys(tokenFieldMap) as (keyof Token.ExecutionUsage)[]) {
      const value = usage[field];
      if (value !== undefined) total[field] = (total[field] ?? 0) + value;
    }
  }
  return total;
}

function firstCount(record: StructuredLogData, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = record[field];
    if (Number.isInteger(value) && typeof value === "number" && value >= 0) return value;
  }
  return undefined;
}

function firstString(record: StructuredLogData, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function normalizeToolStatus(status: string | undefined): ToolStatus | undefined {
  if (
    status === "pending" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "error"
  ) {
    return status;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is StructuredLogData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDefined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}
