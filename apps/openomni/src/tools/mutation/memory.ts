import { z } from "zod";
import type { CuratedMemory } from "../../memory/store";
import { MEMORY_STORES, MemoryRefusal } from "../../memory/store";
import { defineTool, ToolRefused } from "../core/define";

const Input = z
  .object({
    action: z.enum(["add", "replace", "remove"]),
    store: z
      .enum(MEMORY_STORES)
      .describe("system = durable operating notes; owner = the Owner's profile."),
    id: z.string().min(1).optional().describe("Which entry (replace and remove only)."),
    content: z.string().min(1).optional().describe("The entry text (add and replace only)."),
  })
  .strict()
  .superRefine((value, context) => {
    const wants: Record<typeof value.action, { id: boolean; content: boolean }> = {
      add: { id: false, content: true },
      replace: { id: true, content: true },
      remove: { id: true, content: false },
    };
    const want = wants[value.action];
    if (want.id !== (value.id !== undefined)) {
      context.addIssue({
        code: "custom",
        message: `${value.action} ${want.id ? "requires" : "takes no"} id`,
      });
    }
    if (want.content !== (value.content !== undefined)) {
      context.addIssue({
        code: "custom",
        message: `${value.action} ${want.content ? "requires" : "takes no"} content`,
      });
    }
  });

const Output = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("add"), store: z.enum(MEMORY_STORES), id: z.string().min(1) })
    .strict(),
  z
    .object({ action: z.literal("replace"), store: z.enum(MEMORY_STORES), id: z.string().min(1) })
    .strict(),
  z
    .object({ action: z.literal("remove"), store: z.enum(MEMORY_STORES), id: z.string().min(1) })
    .strict(),
]);

export const MEMORY_TOOL_NAME = "memory";

function executeMemory(memory: CuratedMemory) {
  return async ({
    action,
    store,
    id,
    content,
  }: z.output<typeof Input>): Promise<z.output<typeof Output>> => {
    try {
      switch (action) {
        case "add":
          return { action, store, id: memory.add(store, content as string) };
        case "replace":
          memory.replace(store, id as string, content as string);
          return { action, store, id: id as string };
        case "remove":
          memory.remove(store, id as string);
          return { action, store, id: id as string };
      }
    } catch (error) {
      if (error instanceof MemoryRefusal) throw new ToolRefused(MEMORY_TOOL_NAME, error.message);
      throw error;
    }
  };
}

export function createMemoryTool(memory: CuratedMemory) {
  return defineTool({
    name: MEMORY_TOOL_NAME,
    category: "mutation",
    description:
      "Curate durable memory: add, replace, or remove an entry in the system or owner store. What memory holds is already in your context under # Memory — there is no read. Budgets are hard: when a store is full, curate instead of appending. Writes render from the NEXT session, not this one.",
    input: Input,
    output: Output,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: executeMemory(memory),
    render: (_args, value) => {
      switch (value.action) {
        case "add":
          return `remembered as [${value.id}] in the ${value.store} store (renders next session)`;
        case "replace":
          return `replaced [${value.id}] in the ${value.store} store (renders next session)`;
        case "remove":
          return `removed [${value.id}] from the ${value.store} store`;
      }
    },
  });
}
