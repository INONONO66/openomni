import type { ExecutionEvent } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Log } from "../log/index.js";
import { EventLog } from "./index.js";

type DurableVisibility = Exclude<NonNullable<Bus.PublishedDescriptor["visibility"]>, "ephemeral">;

export interface BaseFields {
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly visibility: DurableVisibility;
  readonly timestamp: string;
  readonly sequence: number;
}

export interface MapperInput {
  readonly eventName: string;
  readonly payload: unknown;
  readonly base: BaseFields;
}

export type EventMapper = (input: MapperInput) => ExecutionEvent | undefined;

export namespace EventLogBridge {
  export interface Options {
    readonly resolveSessionId?: (
      event: Bus.PublishedDescriptor,
      payload: unknown,
    ) => string | undefined;
    readonly now?: () => Date;
    readonly registry?: Readonly<Record<string, EventMapper>>;
  }

  export function start(options: Options = {}): () => void {
    const sequences = new Map<string, Promise<number>>();
    const registry = options.registry ?? knownEventMappers;
    const now = options.now ?? (() => new Date());
    const resolveSessionId = options.resolveSessionId ?? defaultResolveSessionId;

    return Bus.observe((event, payload) => {
      if ((event.visibility ?? "internal") === "ephemeral") {
        return;
      }

      const normalizedPayload = parsePayload(event, payload);
      const sessionId = resolveSessionId(event, normalizedPayload);
      if (sessionId === undefined) {
        return;
      }

      void mirror({ event, payload: normalizedPayload, sessionId, registry, now, sequences }).catch(
        (err) => {
          Log.warn("EventLogBridge: append failed", {
            event: event.name,
            sessionId,
            error: String(err),
          });
        },
      );
    });
  }
}

interface MirrorInput {
  readonly event: Bus.PublishedDescriptor;
  readonly payload: unknown;
  readonly sessionId: string;
  readonly registry: Readonly<Record<string, EventMapper>>;
  readonly now: () => Date;
  readonly sequences: Map<string, Promise<number>>;
}

async function mirror(input: MirrorInput): Promise<void> {
  const sequence = await reserveSequence(input.sessionId, input.sequences);
  const eventTime = getNumberField(input.payload, "time");
  const base: BaseFields = {
    actionId: buildActionId(input.sessionId, input.event.name, sequence, input.payload),
    parentActionId: getStringField(input.payload, "parentActionId"),
    visibility: durableVisibility(input.event.visibility),
    timestamp: new Date(eventTime ?? input.now().getTime()).toISOString(),
    sequence,
  };

  const mapped = input.registry[input.event.name]?.({
    eventName: input.event.name,
    payload: input.payload,
    base,
  });

  await EventLog.append(
    input.sessionId,
    mapped ?? toGenericBusEvent(input.event.name, input.payload, base),
  );
}

function reserveSequence(
  sessionId: string,
  sequences: Map<string, Promise<number>>,
): Promise<number> {
  const current = sequences.get(sessionId) ?? readNextSequence(sessionId);
  sequences.set(
    sessionId,
    current.then(
      (sequence) => sequence + 1,
      () => 1,
    ),
  );
  return current;
}

async function readNextSequence(sessionId: string): Promise<number> {
  let maxSequence = 0;
  for await (const event of EventLog.replay(sessionId)) {
    maxSequence = Math.max(maxSequence, event.sequence);
  }
  return maxSequence + 1;
}

function durableVisibility(visibility: Bus.PublishedDescriptor["visibility"]): DurableVisibility {
  if (visibility === "llm_reason" || visibility === "user_audit") {
    return visibility;
  }
  return "internal";
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
  if (result.success) {
    return result.data;
  }

  Log.warn("EventLogBridge: invalid bus payload", { event: event.name });
  return payload;
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

function toSafeParseSchema(schema: unknown): SafeParseSchema | undefined {
  if (schema === null || typeof schema !== "object") {
    return undefined;
  }

  const candidate = schema as { readonly safeParse?: unknown };
  return typeof candidate.safeParse === "function" ? (candidate as SafeParseSchema) : undefined;
}

function toGenericBusEvent(
  name: string,
  payload: unknown,
  base: BaseFields,
): ExecutionEvent.MirroredBusEvent {
  return {
    type: "bus_event",
    name,
    payload: payload === undefined ? null : payload,
    ...base,
  };
}

const knownEventMappers: Readonly<Record<string, EventMapper>> = {
  "tool.execution.started": ({ payload, base }) => {
    const toolCallId = getStringField(payload, "toolCallId");
    const toolName = getStringField(payload, "toolName");
    if (!toolCallId || !toolName) return undefined;

    const args = toolStartedArgs(payload);
    return {
      type: "tool_started",
      toolCallId,
      toolName,
      ...(args !== undefined && { args }),
      ...base,
    };
  },
  "tool.execution.completed": ({ payload, base }) => {
    const toolCallId = getStringField(payload, "toolCallId");
    if (!toolCallId) return undefined;

    return {
      type: "tool_completed",
      toolCallId,
      result: {
        id: `${toolCallId}:result`,
        toolCallId,
        output: JSON.stringify({
          durationMs: getNumberField(payload, "durationMs") ?? null,
          isError: getBooleanField(payload, "isError") ?? false,
        }),
        isError: getBooleanField(payload, "isError") ?? false,
      },
      ...base,
    };
  },
  "tool.execution.permission_denied": ({ payload, base }) =>
    actionBlocked(payload, base, "tool.execution.permission_denied"),
};

function toolStartedArgs(payload: unknown): Record<string, unknown> | undefined {
  const inputSummary = getStringField(payload, "inputSummary");
  const actor = getRecordField(payload, "actor");
  const args = {
    ...(inputSummary !== undefined && { inputSummary }),
    ...(actor !== undefined && { actor }),
  };
  return Object.keys(args).length > 0 ? args : undefined;
}

function actionBlocked(
  payload: unknown,
  base: BaseFields,
  policyId: string,
): ExecutionEvent.ActionBlocked | undefined {
  const toolName = getStringField(payload, "toolName");
  if (!toolName) return undefined;

  return {
    type: "action_blocked",
    policyId,
    actor: getActor(payload),
    action: "tool.call",
    resource: toolName,
    verdict: "abort",
    reason: getStringField(payload, "reason") ?? "blocked by bus event",
    ...base,
  };
}

function getActor(payload: unknown): Record<string, unknown> {
  return getRecordField(payload, "actor") ?? legacyActor(payload) ?? {};
}

function legacyActor(payload: unknown): Record<string, unknown> | undefined {
  const actor = {
    ...(getStringField(payload, "agentId") !== undefined && {
      agentId: getStringField(payload, "agentId"),
    }),
    ...(getStringField(payload, "agentName") !== undefined && {
      agentName: getStringField(payload, "agentName"),
    }),
  };
  return Object.keys(actor).length > 0 ? actor : undefined;
}

function buildActionId(
  sessionId: string,
  eventName: string,
  sequence: number,
  payload: unknown,
): string {
  return getStringField(payload, "actionId") ?? `${sessionId}:${eventName}:${sequence}`;
}

function getStringField(value: unknown, key: string): string | undefined {
  const record = toRecord(value);
  return record ? stringFromRecord(record, key) : undefined;
}

function getNumberField(value: unknown, key: string): number | undefined {
  const record = toRecord(value);
  const field = record?.[key];
  return typeof field === "number" ? field : undefined;
}

function getBooleanField(value: unknown, key: string): boolean | undefined {
  const record = toRecord(value);
  const field = record?.[key];
  return typeof field === "boolean" ? field : undefined;
}

function getRecordField(value: unknown, key: string): Record<string, unknown> | undefined {
  const record = toRecord(value);
  return record ? toRecord(record[key]) : undefined;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
