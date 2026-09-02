import { Trigger, type Tool } from "@openomni/protocol";
import { z } from "zod";

export interface TriggerToolPort {
  create(ownerSessionId: string, input: unknown): Promise<Trigger.Record>;
  list(ownerSessionId: string, includeEnded: boolean): Promise<Trigger.Record[]>;
  cancel(ownerSessionId: string, triggerId: string): Promise<Trigger.Record>;
  rearm(ownerSessionId: string, triggerId: string): Promise<Trigger.Record>;
}

const sourceFields = [
  "at",
  "interval_ms",
  "command",
  "filter",
  "persistent",
  "path",
  "on",
] as const;

type SourceField = (typeof sourceFields)[number];

const branchFields: Record<Trigger.KindName, readonly SourceField[]> = {
  "time.once": ["at"],
  "time.every": ["interval_ms"],
  "event.command": ["command", "filter", "persistent"],
  "event.file": ["path", "on"],
};

const branchRequired: Record<Trigger.KindName, readonly SourceField[]> = {
  "time.once": ["at"],
  "time.every": ["interval_ms"],
  "event.command": ["command"],
  "event.file": ["path"],
};

const TriggerCreateToolSourceInput = z
  .object({
    kind: z.enum(Trigger.Kinds),
    at: z.number().int().min(0).max(Trigger.Constants.MAX_COUNTER).optional(),
    interval_ms: z.number().int().positive().max(Trigger.Constants.MAX_COUNTER).optional(),
    command: z.string().min(1).max(Trigger.Constants.MAX_COMMAND_CHARS).optional(),
    filter: z.string().max(Trigger.Constants.MAX_FILTER_CHARS).optional(),
    persistent: z.boolean().optional(),
    path: z.string().min(1).max(Trigger.Constants.MAX_PATH_CHARS).optional(),
    on: z.enum(["create", "modify"]).optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    const allowed = new Set(branchFields[source.kind]);
    for (const field of sourceFields) {
      if (source[field] !== undefined && !allowed.has(field)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is not valid for ${source.kind}`,
        });
      }
    }
    for (const field of branchRequired[source.kind]) {
      if (source[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for ${source.kind}`,
        });
      }
    }
  });

export const TriggerCreateToolInput = z
  .object({
    prompt: z.string().min(1).max(Trigger.Constants.MAX_PROMPT_CHARS),
    source: TriggerCreateToolSourceInput,
  })
  .strict();

const TriggerListInput = z
  .object({
    include_ended: z.boolean().default(false),
  })
  .strict();

const TriggerIdInput = z
  .object({
    trigger_id: z.string().min(1),
  })
  .strict();

export const TRIGGER_CREATE_TOOL_NAME = "trigger_create";
export const TRIGGER_LIST_TOOL_NAME = "trigger_list";
export const TRIGGER_CANCEL_TOOL_NAME = "trigger_cancel";
export const TRIGGER_REARM_TOOL_NAME = "trigger_rearm";

const SOURCE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: [...Trigger.Kinds] },
    at: { type: "integer", minimum: 0, maximum: Trigger.Constants.MAX_COUNTER },
    interval_ms: { type: "integer", minimum: 1, maximum: Trigger.Constants.MAX_COUNTER },
    command: {
      type: "string",
      minLength: 1,
      maxLength: Trigger.Constants.MAX_COMMAND_CHARS,
    },
    filter: { type: "string", maxLength: Trigger.Constants.MAX_FILTER_CHARS },
    persistent: { type: "boolean" },
    path: { type: "string", minLength: 1, maxLength: Trigger.Constants.MAX_PATH_CHARS },
    on: { type: "string", enum: ["create", "modify"] },
  },
};

const CREATE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "source"],
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: Trigger.Constants.MAX_PROMPT_CHARS,
    },
    source: SOURCE_JSON_SCHEMA,
  },
};

const LIST_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    include_ended: { type: "boolean", default: false },
  },
};

const ID_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["trigger_id"],
  properties: {
    trigger_id: { type: "string", minLength: 1 },
  },
};

export function triggerCreateToolSpec(): Tool.Spec {
  return {
    name: TRIGGER_CREATE_TOOL_NAME,
    description:
      "Create one durable alarm or command/file observation for this Resident session. The trigger is recorded before its timer or source starts.",
    inputSchema: CREATE_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function triggerListToolSpec(): Tool.Spec {
  return {
    name: TRIGGER_LIST_TOOL_NAME,
    description:
      "List this Resident session's durable triggers and lifecycle state; ended history is omitted unless requested.",
    inputSchema: LIST_JSON_SCHEMA,
    safe: true,
    placement: "host",
  };
}

export function triggerCancelToolSpec(): Tool.Spec {
  return {
    name: TRIGGER_CANCEL_TOOL_NAME,
    description:
      "Cancel future source work for one trigger owned by this Resident session. Recorded fires remain deliverable.",
    inputSchema: ID_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function triggerRearmToolSpec(): Tool.Spec {
  return {
    name: TRIGGER_REARM_TOOL_NAME,
    description:
      "Re-arm one paused trigger owned by this Resident session and reset its notification suppression.",
    inputSchema: ID_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export type TriggerToolLifecycle =
  | { readonly state: "armed" }
  | {
      readonly state: "paused";
      readonly reason: Trigger.PauseReason;
      readonly at: number;
    }
  | {
      readonly state: "ended";
      readonly reason: Trigger.EndReason;
      readonly at: number;
      readonly detail?: string;
    };

function triggerToolLifecycle(record: Trigger.Record): TriggerToolLifecycle {
  switch (record.lifecycle.state) {
    case "armed":
      return { state: "armed" };
    case "paused":
      return {
        state: "paused",
        reason: record.lifecycle.pauseReason,
        at: record.lifecycle.pausedAt,
      };
    case "ended":
      return {
        state: "ended",
        reason: record.lifecycle.endReason,
        at: record.lifecycle.endedAt,
        ...(record.lifecycle.endDetail === undefined
          ? {}
          : { detail: record.lifecycle.endDetail }),
      };
  }
}

function creationResult(record: Trigger.Record) {
  return {
    trigger_id: record.id,
    kind: record.source.kind,
    lifecycle: triggerToolLifecycle(record),
    ...(record.nextFireAt === undefined ? {} : { next_fire_at: record.nextFireAt }),
    ...(record.expiresAt === undefined ? {} : { expires_at: record.expiresAt }),
  };
}

function listResult(record: Trigger.Record) {
  return {
    ...creationResult(record),
    fire_count: record.fireCount,
    last_observed_at: record.lastObservedAt,
    ...(record.lastFiredAt === undefined ? {} : { last_fired_at: record.lastFiredAt }),
  };
}

function errorCode(error: unknown): string {
  if (Trigger.StoreError.isInstance(error)) return error.data.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "unavailable";
}

function refusal(name: string, error: unknown): string {
  return JSON.stringify({
    error: {
      tool: name,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

export function triggerCreateToolExecutor(port: TriggerToolPort, ownerSessionId: string) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = TriggerCreateToolInput.safeParse(rawInput);
    if (!parsed.success) return refusal(TRIGGER_CREATE_TOOL_NAME, parsed.error);
    try {
      return JSON.stringify(creationResult(await port.create(ownerSessionId, parsed.data)));
    } catch (error) {
      return refusal(TRIGGER_CREATE_TOOL_NAME, error);
    }
  };
}

export function triggerListToolExecutor(port: TriggerToolPort, ownerSessionId: string) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = TriggerListInput.safeParse(rawInput);
    if (!parsed.success) return refusal(TRIGGER_LIST_TOOL_NAME, parsed.error);
    try {
      const records = await port.list(ownerSessionId, parsed.data.include_ended);
      return JSON.stringify({ triggers: records.map(listResult) });
    } catch (error) {
      return refusal(TRIGGER_LIST_TOOL_NAME, error);
    }
  };
}

export function triggerCancelToolExecutor(port: TriggerToolPort, ownerSessionId: string) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = TriggerIdInput.safeParse(rawInput);
    if (!parsed.success) return refusal(TRIGGER_CANCEL_TOOL_NAME, parsed.error);
    try {
      const record = await port.cancel(ownerSessionId, parsed.data.trigger_id);
      return JSON.stringify({ trigger_id: record.id, lifecycle: triggerToolLifecycle(record) });
    } catch (error) {
      return refusal(TRIGGER_CANCEL_TOOL_NAME, error);
    }
  };
}

export function triggerRearmToolExecutor(port: TriggerToolPort, ownerSessionId: string) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = TriggerIdInput.safeParse(rawInput);
    if (!parsed.success) return refusal(TRIGGER_REARM_TOOL_NAME, parsed.error);
    try {
      return JSON.stringify(creationResult(await port.rearm(ownerSessionId, parsed.data.trigger_id)));
    } catch (error) {
      return refusal(TRIGGER_REARM_TOOL_NAME, error);
    }
  };
}
