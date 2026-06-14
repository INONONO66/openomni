import { existsSync } from "node:fs";
import type { AppConnector, Execution } from "@openomni/protocol";
import { Artifact } from "@openomni/session";
import { type ConnectorTemplateValues, redactConnectorCredentialValues } from "./env.js";
import { newestConnectorGlobMatch, resolveConnectorLogPath } from "./log-path.js";
import { aggregateConnectorLogUsage, buildConnectorLogEvent } from "./log-telemetry.js";

type ExecutionArtifact = NonNullable<Execution.Result["artifacts"]>[number];
type ExecutionLogEvent = NonNullable<Execution.Result["logEvents"]>[number];

export interface ConnectorLogIngestion {
  readonly artifacts: ExecutionArtifact[];
  readonly logEvents: ExecutionLogEvent[];
  readonly usage?: Execution.Result["usage"];
  readonly finalMessage?: string;
}

export interface ConnectorLogIngestionInput {
  readonly connector: AppConnector.Definition;
  readonly runId: string;
  readonly sessionId: string;
  readonly values: ConnectorTemplateValues;
  readonly redactions: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

export async function ingestConnectorLogs(
  input: ConnectorLogIngestionInput,
): Promise<ConnectorLogIngestion> {
  const logs = input.connector.logs;
  if (logs === undefined) return { artifacts: [], logEvents: [] };

  const rawContent = await readLogContent(logs.path, input);
  if (rawContent === undefined) return { artifacts: [], logEvents: [] };
  const content = redactConnectorCredentialValues(rawContent, input.redactions);
  const meta = {
    id: `art_${crypto.randomUUID()}`,
    sessionId: input.sessionId,
    mimeType: mimeTypeForLog(logs),
    title: `${input.connector.name} ${input.runId} log`,
    version: 1,
    createdAt: new Date().toISOString(),
  };
  await Artifact.store(input.sessionId, meta, content);

  const logEvents = extractLogEvents(logs, content, meta.id);
  return {
    artifacts: [
      {
        kind: "connector_log",
        artifactId: meta.id,
        title: meta.title,
        mimeType: meta.mimeType,
      },
    ],
    logEvents,
    usage: aggregateConnectorLogUsage(logs, logEvents),
    finalMessage: extractFinalLogMessage(logs, content),
  };
}

async function readLogContent(
  pathTemplate: string,
  input: ConnectorLogIngestionInput,
): Promise<string | undefined> {
  if (pathTemplate === "stdout") return input.stdout;
  if (pathTemplate === "stderr") return input.stderr;

  const path = resolveConnectorLogPath(pathTemplate, input.values);
  if (path.includes("*")) {
    const match = newestConnectorGlobMatch(path);
    return match === undefined ? undefined : Bun.file(match).text();
  }
  if (!existsSync(path)) return undefined;
  return Bun.file(path).text();
}

function mimeTypeForLog(logs: AppConnector.Logs): string {
  switch (logs.kind) {
    case "jsonl":
    case "stream_json":
      return "application/x-ndjson";
    case "text":
      return "text/plain";
    default:
      throw new Error(`unsupported connector process log kind: ${(logs as { kind: string }).kind}`);
  }
}

function extractFinalLogMessage(logs: AppConnector.Logs, content: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  if (logs.kind === "text") return trimmed;

  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const message = extractStructuredMessage(line, logs.messageField);
    if (message !== undefined) return message;
  }
  return trimmed;
}

function extractStructuredMessage(line: string, messageField: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const message = (value as Record<string, unknown>)[messageField];
    return typeof message === "string" && message.length > 0 ? message : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

function extractLogEvents(
  logs: AppConnector.Logs,
  content: string,
  artifactId: string,
): ExecutionLogEvent[] {
  if (logs.kind === "text") return [];

  const events: ExecutionLogEvent[] = [];
  for (const line of content.trim().split(/\r?\n/)) {
    const data = parseStructuredLogLine(line);
    if (data === undefined) continue;
    const message = data[logs.messageField];
    if (typeof message !== "string" || message.length === 0) continue;
    const timestampValue = data[logs.eventTimeField];
    events.push(
      buildConnectorLogEvent(logs, data, {
        kind: "connector_log_event",
        artifactId,
        message,
        ...(typeof timestampValue === "string" || typeof timestampValue === "number"
          ? { timestamp: String(timestampValue) }
          : {}),
        sequence: events.length,
        data,
      }),
    );
  }
  return events;
}

function parseStructuredLogLine(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}
