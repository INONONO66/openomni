import type { Tool } from "@openomni/protocol";
import { z } from "zod";
import type { DelegationOrigin } from "./admission";
import { type DelegationKernel, formatSettlement } from "./kernel";

/**
 * The model asks in relative time; the kernel records an absolute deadline
 * using its injected clock. This is the only boundary where those meet.
 */
const StartInput = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const value = raw as Record<string, unknown>;
    // v1 callers used `mode`; accepting it at the boundary keeps old prompts
    // readable while the advertised v2 surface names the protocol operation.
    if (value.operation === undefined && value.mode !== undefined) {
      const { mode: _mode, ...rest } = value;
      return { ...rest, operation: value.mode };
    }
    return raw;
  },
  z
    .object({
      instruction: z.string().min(1).describe("What the recipient must do, stated so it can stand alone."),
      operation: z
        .enum(["notify", "ask", "assign"])
        .describe("notify = send and do not expect a reply; ask = request an answer; assign = commission work."),
      scope: z
        .enum(["inline", "independent"])
        .optional()
        .describe("inline = volatile same-domain child; independent = isolated process."),
      actorId: z
        .string()
        .min(1)
        .optional()
        .describe("Registered external actor; use instead of scope."),
      acceptanceCriteria: z
        .array(z.string().min(1))
        .optional()
        .describe("Required for assign and forbidden for ask/notify."),
      timeoutMs: z.number().int().positive().describe("How long the delegation may remain open."),
    })
    .strict()
    .superRefine((input, ctx) => {
      const hasScope = input.scope !== undefined;
      const hasActor = input.actorId !== undefined;
      if (hasScope === hasActor) {
        ctx.addIssue({
          code: "custom",
          message: "exactly one of scope or actorId must be given",
          path: ["scope"],
        });
      }
      if (input.operation === "notify" && !hasActor) {
        ctx.addIssue({
          code: "custom",
          message: "notify reaches actor addresses only",
          path: ["actorId"],
        });
      }
      if (input.operation === "assign" && input.scope === "inline") {
        ctx.addIssue({
          code: "custom",
          message: "assign never runs inline; use ask for an inline helper",
          path: ["scope"],
        });
      }
      if (input.operation === "assign" && (input.acceptanceCriteria?.length ?? 0) === 0) {
        ctx.addIssue({
          code: "custom",
          message: "assign requires at least one acceptance criterion",
          path: ["acceptanceCriteria"],
        });
      }
      if (input.operation !== "assign" && input.acceptanceCriteria !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${input.operation} carries no acceptance criteria`,
          path: ["acceptanceCriteria"],
        });
      }
    }),
);

type StartInput = z.infer<typeof StartInput>;

export const DELEGATE_TOOL_NAME = "delegate";
export const AWAIT_DELEGATION_TOOL_NAME = "await_delegation";
export const CANCEL_DELEGATION_TOOL_NAME = "cancel_delegation";

const START_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["instruction", "operation", "timeoutMs"],
  properties: {
    instruction: { type: "string", minLength: 1 },
    operation: { type: "string", enum: ["notify", "ask", "assign"] },
    scope: { type: "string", enum: ["inline", "independent"] },
    actorId: { type: "string", minLength: 1 },
    acceptanceCriteria: { type: "array", items: { type: "string", minLength: 1 } },
    timeoutMs: { type: "integer", exclusiveMinimum: 0 },
  },
};

const AWAIT_INPUT = z
  .object({
    delegationId: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
const AWAIT_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["delegationId"],
  properties: {
    delegationId: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", exclusiveMinimum: 0 },
  },
};

const CANCEL_INPUT = z.object({ delegationId: z.string().min(1) }).strict();
const CANCEL_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["delegationId"],
  properties: { delegationId: { type: "string", minLength: 1 } },
};

export function delegateToolSpec(): Tool.Spec {
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      "Start durable delegated work. Inline ask waits in this turn; process/channel work returns a handle immediately and its settlement arrives as a message. Notify sends once to an actor and settles sent at transport acceptance.",
    inputSchema: START_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function awaitDelegationToolSpec(): Tool.Spec {
  return {
    name: AWAIT_DELEGATION_TOOL_NAME,
    description:
      "Re-invoke a durable delegation by id. It returns its settlement when available, or says it is still open until the supplied wait limit.",
    inputSchema: AWAIT_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function cancelDelegationToolSpec(): Tool.Spec {
  return {
    name: CANCEL_DELEGATION_TOOL_NAME,
    description: "Cancel open delegated work by id; cancelling settled work returns the existing settlement.",
    inputSchema: CANCEL_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

function handleText(handle: {
  delegationId: string;
  operation: string;
  transport: string;
  deadline: number;
  waitId?: string;
}): string {
  return [
    `delegation ${handle.delegationId} accepted`,
    `operation=${handle.operation}`,
    `transport=${handle.transport}`,
    `deadline=${handle.deadline}`,
    ...(handle.waitId === undefined ? [] : [`waitId=${handle.waitId}`]),
    "settlement will arrive as a message",
  ].join("; ");
}

function refusalText(prefix: string, error: unknown): string {
  const candidate: unknown = error;
  if (typeof candidate === "object" && candidate !== null && "data" in candidate) {
    const data = candidate.data;
    if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string") {
      return `${prefix} refused: ${data.message}`;
    }
  }
  if (typeof candidate === "object" && candidate !== null && "message" in candidate && typeof candidate.message === "string") {
    return `${prefix} refused: ${candidate.message}`;
  }
  return `${prefix} refused: ${String(candidate)}`;
}

/** Binds the start tool to one trusted originator. */
export function delegateToolExecutor(kernel: DelegationKernel, origin: DelegationOrigin) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = StartInput.safeParse(rawInput);
    if (!parsed.success) {
      return `delegate refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const input: StartInput = parsed.data;
    const request = {
      address:
        input.actorId !== undefined
          ? { kind: "actor" as const, actorId: input.actorId }
          : input.scope === "inline"
            ? { kind: "core" as const, scope: "inline" as const }
            : { kind: "core" as const, scope: "independent" as const },
      operation: input.operation,
      payload: { text: input.instruction },
      ...(input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: input.acceptanceCriteria }),
      deadline: (typeof kernel.now === "function" ? kernel.now() : Date.now()) + input.timeoutMs,
    };

    let result: Awaited<ReturnType<DelegationKernel["delegate"]>>;
    try {
      result = await kernel.delegate(request, origin);
    } catch (error) {
      return refusalText("delegate", error);
    }
    if ("refused" in result) return `delegate refused: ${result.refused}`;
    if (result.settled !== undefined) {
      return formatSettlement(result.settled);
    }
    return handleText(result.handle);
  };
}

export function awaitDelegationToolExecutor(kernel: DelegationKernel) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = AWAIT_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `await_delegation refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    try {
      const result = await kernel.awaitDelegation(parsed.data.delegationId, parsed.data.timeoutMs);
      if (result.kind === "timeout") {
        return `delegation ${result.delegationId} is still open; settlement will arrive as a message`;
      }
      return formatSettlement(result.settlement);
    } catch (error) {
      return refusalText("await_delegation", error);
    }
  };
}

export function cancelDelegationToolExecutor(kernel: DelegationKernel) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = CANCEL_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `cancel_delegation refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    try {
      return formatSettlement(await kernel.cancelDelegation(parsed.data.delegationId));
    } catch (error) {
      return refusalText("cancel_delegation", error);
    }
  };
}
