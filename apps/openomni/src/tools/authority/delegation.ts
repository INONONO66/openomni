import type { Delegation } from "@openomni/protocol";
import { z } from "zod";
import { defineTool, ToolRefused } from "@openomni/agent";
import type { DelegationOrigin } from "../../delegation/admission";
import { type DelegationKernel, formatSettlement } from "../../delegation/kernel";

/**
 * The model asks in relative time; the kernel records an absolute deadline
 * using its injected clock. This is the only boundary where those meet.
 */
const StartInput = z
  .object({
    instruction: z
      .string()
      .min(1)
      .describe("What the recipient must do, stated so it can stand alone."),
    operation: z
      .enum(["notify", "ask", "assign"])
      .describe(
        "notify = send and do not expect a reply; ask = request an answer; assign = commission work.",
      ),
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
  });

type StartInput = z.infer<typeof StartInput>;

export const DELEGATE_TOOL_NAME = "delegate";
export const AWAIT_DELEGATION_TOOL_NAME = "await_delegation";
export const CANCEL_DELEGATION_TOOL_NAME = "cancel_delegation";

const AWAIT_INPUT = z
  .object({
    delegationId: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
const CANCEL_INPUT = z.object({ delegationId: z.string().min(1) }).strict();

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

function refusalReason(error: unknown): string {
  const candidate: unknown = error;
  if (typeof candidate === "object" && candidate !== null && "data" in candidate) {
    const data = candidate.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
    ) {
      return data.message;
    }
  }
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "message" in candidate &&
    typeof candidate.message === "string"
  ) {
    return candidate.message;
  }
  return String(candidate);
}

/** Executes start for one trusted role/depth; session identity comes from the call context. */
function executeDelegate(kernel: DelegationKernel, role: DelegationOrigin["role"], depth: number) {
  return async (input: StartInput, sessionId: string) => {
    const origin: DelegationOrigin = { role, depth, sessionId };
    const request = {
      address:
        input.actorId !== undefined
          ? { kind: "actor" as const, actorId: input.actorId }
          : input.scope === "inline"
            ? { kind: "core" as const, scope: "inline" as const }
            : { kind: "core" as const, scope: "independent" as const },
      operation: input.operation,
      payload: { text: input.instruction },
      ...(input.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: input.acceptanceCriteria }),
      deadline: kernel.now() + input.timeoutMs,
    };

    let result: Awaited<ReturnType<DelegationKernel["delegate"]>>;
    try {
      result = await kernel.delegate(request, origin);
    } catch (error) {
      throw new ToolRefused(DELEGATE_TOOL_NAME, refusalReason(error));
    }
    if ("refused" in result) throw new ToolRefused(DELEGATE_TOOL_NAME, result.refused);
    if (result.settled !== undefined)
      return { kind: "settled" as const, settlement: result.settled };
    return { kind: "accepted" as const, handle: result.handle };
  };
}

function executeAwaitDelegation(kernel: DelegationKernel) {
  return async (input: z.output<typeof AWAIT_INPUT>) => {
    try {
      const result = await kernel.awaitDelegation(input.delegationId, input.timeoutMs);
      if (result.kind === "timeout")
        return { kind: "timeout" as const, delegationId: result.delegationId };
      return { kind: "settled" as const, settlement: result.settlement };
    } catch (error) {
      throw new ToolRefused(AWAIT_DELEGATION_TOOL_NAME, refusalReason(error));
    }
  };
}

function executeCancelDelegation(kernel: DelegationKernel) {
  return async (input: z.output<typeof CANCEL_INPUT>) => {
    try {
      return { settlement: await kernel.cancelDelegation(input.delegationId) };
    } catch (error) {
      throw new ToolRefused(CANCEL_DELEGATION_TOOL_NAME, refusalReason(error));
    }
  };
}

const Settlement = z.custom<Delegation.Settled>(
  (value) => typeof value === "object" && value !== null,
);
const DelegateOutput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settled"), settlement: Settlement }).strict(),
  z
    .object({
      kind: z.literal("accepted"),
      handle: z
        .object({
          delegationId: z.string(),
          operation: z.string(),
          transport: z.string(),
          deadline: z.number(),
          waitId: z.string().optional(),
        })
        .passthrough(),
    })
    .strict(),
]);
const AwaitOutput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settled"), settlement: Settlement }).strict(),
  z.object({ kind: z.literal("timeout"), delegationId: z.string() }).strict(),
]);
const CancelOutput = z.object({ settlement: Settlement }).strict();
const visibility = { model: ["resident", "worker"], cell: ["resident", "worker"] } as const;
export function createDelegateTool(
  kernel: DelegationKernel,
  role: DelegationOrigin["role"],
  depth: number,
) {
  const execute = executeDelegate(kernel, role, depth);
  return defineTool({
    name: DELEGATE_TOOL_NAME,
    category: "authority",
    description:
      "Start durable delegated work. Inline ask waits in this turn; process/channel work returns a handle immediately and its settlement arrives as a message.",
    input: StartInput,
    output: DelegateOutput,
    visibility,
    execute: (input, ctx) => execute(input, ctx.sessionId),
    render: (_args, value) =>
      value.kind === "settled" ? formatSettlement(value.settlement) : handleText(value.handle),
  });
}
export function createAwaitDelegationTool(kernel: DelegationKernel) {
  return defineTool({
    name: AWAIT_DELEGATION_TOOL_NAME,
    category: "authority",
    description:
      "Re-invoke a durable delegation by id. It returns its settlement when available, or says it is still open until the supplied wait limit.",
    input: AWAIT_INPUT,
    output: AwaitOutput,
    visibility,
    execute: executeAwaitDelegation(kernel),
    render: (_args, value) =>
      value.kind === "timeout"
        ? `delegation ${value.delegationId} is still open; settlement will arrive as a message`
        : formatSettlement(value.settlement),
  });
}
export function createCancelDelegationTool(kernel: DelegationKernel) {
  return defineTool({
    name: CANCEL_DELEGATION_TOOL_NAME,
    category: "authority",
    description:
      "Cancel open delegated work by id; cancelling settled work returns the existing settlement.",
    input: CANCEL_INPUT,
    output: CancelOutput,
    visibility,
    execute: executeCancelDelegation(kernel),
    render: (_args, value) => formatSettlement(value.settlement),
  });
}
