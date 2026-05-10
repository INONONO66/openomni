import type { Database } from "bun:sqlite";
import { Bus, BusEvent } from "../bus/index.js";
import { Storage } from "../storage/storage.js";

const noSessionKey = "__openomni_bus_event_without_session__";

interface PersistableAdapter {
  readonly db?: Database;
}

interface SafeParseSuccess {
  readonly success: true;
  readonly data: unknown;
}

interface SafeParseFailure {
  readonly success: false;
}

interface SafeParseSchema {
  safeParse(value: unknown): SafeParseSuccess | SafeParseFailure;
}

interface RuntimeState {
  readonly unsubscribe: () => void;
  readonly chains: Map<string, Promise<void>>;
}

export namespace BusPersistence {
  export interface Options {
    readonly resolveSessionId?: (
      event: Bus.PublishedDescriptor,
      payload: unknown,
    ) => string | undefined;
    readonly now?: () => Date;
  }

  let state: RuntimeState | undefined;

  export function start(options: Options = {}): () => void {
    stop();

    const chains = new Map<string, Promise<void>>();
    const resolveSessionId = options.resolveSessionId ?? defaultResolveSessionId;
    const now = options.now ?? (() => new Date());

    const unsubscribe = Bus.observe((event, payload) => {
      const normalizedPayload = parsePayload(event, payload);

      writeOperationalToStdout(event.name, normalizedPayload);

      if ((event.visibility ?? "internal") === BusEvent.Visibility.Enum.ephemeral) {
        return;
      }

      const sessionId = resolveSessionId(event, normalizedPayload);
      const key = sessionId ?? noSessionKey;
      const previous = chains.get(key) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => persist({ event, payload: normalizedPayload, sessionId, now }));

      chains.set(key, current);
      void current
        .catch((err) => {
          console.warn("BusPersistence: persist failed", {
            event: event.name,
            sessionId,
            error: String(err),
          });
        })
        .finally(() => {
          if (chains.get(key) === current) {
            chains.delete(key);
          }
        });
    });

    state = { unsubscribe, chains };
    return stop;
  }

  export function stop(): void {
    state?.unsubscribe();
    state = undefined;
  }
}

interface PersistInput {
  readonly event: Bus.PublishedDescriptor;
  readonly payload: unknown;
  readonly sessionId?: string;
  readonly now: () => Date;
}

async function persist(input: PersistInput): Promise<void> {
  const db = getDatabase();
  const data = JSON.stringify(input.payload === undefined ? null : input.payload);
  const traceId = getTraceField(input.payload, "traceId") ?? crypto.randomUUID();
  const runId = getTraceField(input.payload, "runId");
  const durationMs = getNumberTraceField(input.payload, "durationMs");
  const timeCreated = getNumberTraceField(input.payload, "time") ?? input.now().getTime();

  db.query(
    `INSERT INTO bus_event
       (session_id, run_id, event_type, category, data, trace_id, duration_ms, time_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId ?? null,
    runId ?? null,
    input.event.name,
    categoryOf(input.event.name),
    data,
    traceId,
    durationMs ?? null,
    timeCreated,
  );
}

function getDatabase(): Database {
  const adapter = Storage.getAdapter() as PersistableAdapter;
  if (adapter.db === undefined) {
    throw new Error("BusPersistence requires a SQLite-backed storage adapter");
  }
  return adapter.db;
}

function defaultResolveSessionId(
  _event: Bus.PublishedDescriptor,
  payload: unknown,
): string | undefined {
  const root = toRecord(payload);
  if (!root) return undefined;

  const direct = stringFromRecord(root, "sessionId") ?? stringFromRecord(root, "id");
  if (direct !== undefined) return direct;

  const nestedPayload = toRecord(root.payload);
  const nested = nestedPayload
    ? (stringFromRecord(nestedPayload, "sessionId") ??
      stringFromRecord(nestedPayload, "parentSessionId"))
    : undefined;
  if (nested !== undefined) return nested;

  const info = toRecord(root.info);
  return info ? stringFromRecord(info, "id") : undefined;
}

function parsePayload(event: Bus.PublishedDescriptor, payload: unknown): unknown {
  const schema = toSafeParseSchema(event.schema);
  if (schema === undefined) {
    return payload;
  }

  const result = schema.safeParse(payload);
  return result.success ? result.data : payload;
}

function toSafeParseSchema(schema: unknown): SafeParseSchema | undefined {
  if (schema === null || typeof schema !== "object") {
    return undefined;
  }

  const candidate = schema as { readonly safeParse?: unknown };
  return typeof candidate.safeParse === "function" ? (candidate as SafeParseSchema) : undefined;
}

function categoryOf(eventName: string): string {
  return eventName.split(".", 1)[0] || "custom";
}

function getTraceField(value: unknown, key: string): string | undefined {
  const root = toRecord(value);
  if (!root) return undefined;
  return (
    stringFromRecord(root, key) ??
    stringFromRecord(toRecord(root.payload), key) ??
    stringFromRecord(toRecord(root.traceContext), key)
  );
}

function getNumberTraceField(value: unknown, key: string): number | undefined {
  const root = toRecord(value);
  if (!root) return undefined;
  return (
    numberFromRecord(root, key) ??
    numberFromRecord(toRecord(root.payload), key) ??
    numberFromRecord(toRecord(root.traceContext), key)
  );
}

function stringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const operationalPrefix = "operational.";
const levelNames = new Set<string>(Object.keys(LOG_LEVELS));

function getMinLogLevel(): LogLevel {
  const env = process.env.OPENOMNI_LOG_LEVEL?.toLowerCase();
  return env && env in LOG_LEVELS ? (env as LogLevel) : "info";
}

function writeOperationalToStdout(eventName: string, payload: unknown): void {
  if (!eventName.startsWith(operationalPrefix)) return;

  const level = eventName.slice(operationalPrefix.length).split(".", 1)[0] ?? "";
  if (!levelNames.has(level)) return;
  if (LOG_LEVELS[level as LogLevel] < LOG_LEVELS[getMinLogLevel()]) return;

  const rec = toRecord(payload);
  const ctx = rec ? toRecord(rec.context) : undefined;
  const line = JSON.stringify({
    ts: rec?.time ?? Date.now(),
    level,
    pid: process.pid,
    component: rec?.component ?? "unknown",
    msg: rec?.msg ?? "",
    ...ctx,
  });
  process.stdout.write(`${line}\n`);
}
