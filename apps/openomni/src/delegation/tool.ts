import type { Tool } from "@openomni/protocol";
import { z } from "zod";
import type { DelegationOrigin } from "./admission";
import type { DelegationKernel } from "./kernel";

/**
 * The model asks in relative time because it has no clock; the contract
 * records absolute time because a deadline outlives the turn that set it.
 * This boundary is the only place the two meet.
 */
const Input = z
  .object({
    instruction: z.string().min(1).describe("What the worker must do, stated so it can be read alone."),
    mode: z
      .enum(["ask", "assign"])
      .describe("ask = answer a question; assign = own a piece of work until its criteria are met."),
    scope: z
      .enum(["inline", "independent"])
      .optional()
      .describe("inline = a child in this process sharing your domain; independent = its own worker."),
    actorId: z
      .string()
      .min(1)
      .optional()
      .describe("A registered external actor (a human or an outside agent) to hand the work to instead of an internal worker."),
    acceptanceCriteria: z
      .array(z.string().min(1))
      .optional()
      .describe("Required for assign, forbidden for ask: what makes the work done."),
    timeoutMs: z.number().int().positive().describe("How long to wait before giving up on an answer."),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.scope === undefined) === (input.actorId === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of scope or actorId must be given",
        path: ["scope"],
      });
    }
  });

export const DELEGATE_TOOL_NAME = "delegate";

/**
 * Hand-written rather than derived: this repo is on zod 3, whose JSON Schema
 * conversion lives outside the library. The zod object above stays the
 * runtime gate so a malformed call is refused even if the two ever drift.
 */
const INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["instruction", "mode", "timeoutMs"],
  properties: {
    instruction: {
      type: "string",
      minLength: 1,
      description: "What the worker must do, stated so it can be read alone.",
    },
    mode: {
      type: "string",
      enum: ["ask", "assign"],
      description: "ask = answer a question; assign = own a piece of work until its criteria are met.",
    },
    scope: {
      type: "string",
      enum: ["inline", "independent"],
      description:
        "inline = a child in this process sharing your domain; independent = its own worker. Exactly one of scope or actorId.",
    },
    actorId: {
      type: "string",
      minLength: 1,
      description:
        "A registered external actor (a human or an outside agent) to hand the work to instead of an internal worker. Exactly one of scope or actorId.",
    },
    acceptanceCriteria: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Required for assign, forbidden for ask: what makes the work done.",
    },
    timeoutMs: {
      type: "integer",
      exclusiveMinimum: 0,
      description: "How long to wait before giving up on an answer.",
    },
  },
};

export function delegateToolSpec(): Tool.Spec {
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      "Hand a piece of work to a worker and wait for how it ends. Silence past the deadline is reported as no_response, which means the outcome is unknown — never that the work did not happen.",
    inputSchema: INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

/**
 * Binds the tool to one originator. Each loop gets its own executor because
 * the origin is a property of who is running, never of what they typed —
 * an argument the model could set would make the depth rule self-asserted.
 */
export function delegateToolExecutor(kernel: DelegationKernel, origin: DelegationOrigin) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = Input.safeParse(rawInput);
    if (!parsed.success) {
      return `delegate refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const input = parsed.data;

    const result = await kernel.delegate(
      {
        address:
          input.actorId !== undefined
            ? { kind: "actor", actorId: input.actorId }
            : input.scope === "inline"
              ? { kind: "core", scope: "inline" }
              : { kind: "core", scope: "independent" },
        operation: input.mode,
        payload: { text: input.instruction },
        ...(input.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: input.acceptanceCriteria }),
        deadline: Date.now() + input.timeoutMs,
      },
      origin,
    );

    if ("refused" in result) return `delegate refused: ${result.refused}`;

    const settled = result.settled;
    switch (settled.status) {
      case "completed":
        return settled.output;
      case "failed":
        return `worker failed: ${settled.error}`;
      case "cancelled":
        return `worker cancelled: ${settled.reason}`;
      case "delivery_failed":
        return `never reached a worker: ${settled.reason}`;
      case "no_response":
        return "no response before the deadline — the outcome is unknown, not a failure to act";
      // Neither terminal is reachable through this blocking tool path (the
      // v1 kernel never emits them); they exist for the durable lifecycle.
      case "interrupted":
        return "the host restarted while the work was in flight — the outcome is unknown";
      case "sent":
        return "message sent";
    }
  };
}
