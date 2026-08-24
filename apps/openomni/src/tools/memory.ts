import type { Tool } from "@openomni/protocol";
import { z } from "zod";
import type { CuratedMemory } from "../memory/store";
import { MEMORY_STORES, MemoryRefusal } from "../memory/store";

/**
 * The write surface of the built-in memory layer (kernel-contract §5):
 * add, replace, remove — deliberately no read, because the snapshot is
 * always already in context. A model that wants to know what memory holds
 * looks up, not out.
 */

const Input = z
  .object({
    action: z.enum(["add", "replace", "remove"]),
    store: z.enum(MEMORY_STORES).describe("system = durable operating notes; owner = the Owner's profile."),
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
        code: z.ZodIssueCode.custom,
        message: `${value.action} ${want.id ? "requires" : "takes no"} id`,
      });
    }
    if (want.content !== (value.content !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.action} ${want.content ? "requires" : "takes no"} content`,
      });
    }
  });

export const MEMORY_TOOL_NAME = "memory";

/**
 * Hand-written for the same reason the delegate tool's is: zod 3 ships no
 * JSON Schema conversion. The zod object above stays the runtime gate, and a
 * test pins the two together so they cannot drift apart silently.
 */
const INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["action", "store"],
  properties: {
    action: { type: "string", enum: ["add", "replace", "remove"] },
    store: {
      type: "string",
      enum: [...MEMORY_STORES],
      description: "system = durable operating notes; owner = the Owner's profile.",
    },
    id: { type: "string", minLength: 1, description: "Which entry (replace and remove only)." },
    content: { type: "string", minLength: 1, description: "The entry text (add and replace only)." },
  },
};

export function memoryToolSpec(): Tool.Spec {
  return {
    name: MEMORY_TOOL_NAME,
    description:
      "Curate durable memory: add, replace, or remove an entry in the system or owner store. What memory holds is already in your context under # Memory — there is no read. Budgets are hard: when a store is full, curate instead of appending. Writes render from the NEXT session, not this one.",
    inputSchema: INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function memoryToolExecutor(memory: CuratedMemory) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = Input.safeParse(rawInput);
    if (!parsed.success) {
      return `memory refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const { action, store, id, content } = parsed.data;
    try {
      switch (action) {
        case "add": {
          const newId = memory.add(store, content as string);
          return `remembered as [${newId}] in the ${store} store (renders next session)`;
        }
        case "replace":
          memory.replace(store, id as string, content as string);
          return `replaced [${id}] in the ${store} store (renders next session)`;
        case "remove":
          memory.remove(store, id as string);
          return `removed [${id}] from the ${store} store`;
      }
    } catch (error) {
      if (error instanceof MemoryRefusal) return `memory refused: ${error.message}`;
      throw error;
    }
  };
}
