import { ToolSelection, type Tool } from "@openomni/protocol";
import { z } from "zod";
import type { ChildAgentRuntime, ChildAgentSnapshot } from "../../../child-agent/index.js";
import { defineTool } from "../../define.js";

const toolSelectionSchema = z.object({
  all: z.boolean().optional(),
  categories: z.array(ToolSelection.Category).optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

const childAgentInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("spawn"),
    prompt: z.string().min(1),
    tools: toolSelectionSchema.optional(),
    notifyOnComplete: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("await"),
    ids: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    action: z.literal("inspect"),
    ids: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    action: z.literal("cancel"),
    ids: z.array(z.string().min(1)),
  }),
]);

type ChildAgentInput = z.infer<typeof childAgentInputSchema>;

const publicInputSchema = {
  type: "object",
  properties: {
    action: { enum: ["spawn", "await", "inspect", "cancel"] },
    prompt: { type: "string" },
    notifyOnComplete: { type: "boolean" },
    ids: { type: "array", items: { type: "string" } },
    tools: {
      type: "object",
      properties: {
        all: { type: "boolean" },
        categories: { type: "array", items: { type: "string" } },
        allow: { type: "array", items: { type: "string" } },
        deny: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  required: ["action"],
  additionalProperties: false,
} satisfies Tool.Spec["inputSchema"];

function result(call: Tool.Call, output: unknown, isError?: boolean): Tool.Result {
  return {
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: JSON.stringify(output),
    ...(isError ? { isError: true } : {}),
  };
}

function success(call: Tool.Call, children: readonly ChildAgentSnapshot[]): Tool.Result {
  return result(call, { children });
}

function failure(call: Tool.Call, error: string): Tool.Result {
  return result(call, { status: "failed", error }, true);
}

export function createChildAgentTool(runtime: ChildAgentRuntime) {
  return defineTool<ChildAgentInput>({
    name: "child_agent",
    description: "Spawn and control lightweight child agents inside the current worker run.",
    inputSchema: publicInputSchema,
    source: "agent",
    riskTier: 1,
    isReadOnly: false,
    isConcurrencySafe: true,
    labels: ["delegation", "child-agent"],
    async execute(call) {
      let input: ChildAgentInput;
      try {
        input = childAgentInputSchema.parse(call.input);
      } catch (error) {
        return failure(call, error instanceof Error ? error.message : String(error));
      }

      try {
        switch (input.action) {
          case "spawn": {
            const child = runtime.spawn({
              prompt: input.prompt,
              tools: input.tools,
              ...(input.notifyOnComplete !== undefined
                ? { notifyOnComplete: input.notifyOnComplete }
                : {}),
            });
            return result(call, {
              status: child.status,
              childId: child.id,
              prompt: child.prompt,
            });
          }
          case "await":
            return success(call, await runtime.await(input.ids));
          case "inspect":
            return success(call, runtime.inspect(input.ids));
          case "cancel":
            return success(call, runtime.cancel(input.ids));
        }
      } catch (error) {
        return failure(call, error instanceof Error ? error.message : String(error));
      }
    },
  });
}
