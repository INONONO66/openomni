import type { Tool } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import type { NativeTool, ToolCategory, ToolProvider } from "../types.js";
import { defineTool } from "../define.js";
import { optionalString, requireString } from "../shared/input.js";
import { fromError, successResult } from "../shared/result.js";

function taskCreateTool(): NativeTool {
  return defineTool<{
    id: string;
    title: string;
    description?: string;
    owner: { type: "user" | "agent"; id: string };
    status?: string;
    tags?: string[];
  }>({
    name: "task_create",
    description: "Create a new task",
    riskTier: 1,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        owner: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["user", "agent"] },
            id: { type: "string" },
          },
          required: ["type", "id"],
        },
        status: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "title", "owner"],
    },
    async execute(call) {
      try {
        const input = call.input as Record<string, unknown>;
        const id = requireString(input, "id");
        const title = requireString(input, "title");
        const description = optionalString(input, "description");
        const ownerRaw = input["owner"] as { type: string; id: string } | undefined;
        if (!ownerRaw || typeof ownerRaw !== "object") {
          throw new Error("Invalid input: owner must be an object with type and id");
        }
        const ownerType = ownerRaw.type as "user" | "agent";
        if (ownerType !== "user" && ownerType !== "agent") {
          throw new Error("Invalid input: owner.type must be 'user' or 'agent'");
        }
        const ownerId = ownerRaw.id;
        if (typeof ownerId !== "string" || ownerId.length === 0) {
          throw new Error("Invalid input: owner.id must be a non-empty string");
        }

        const statusRaw = optionalString(input, "status");
        const status = (statusRaw ?? "idle") as
          | "idle"
          | "scheduled"
          | "running"
          | "blocked"
          | "done"
          | "failed"
          | "cancelled";

        const tagsRaw = input["tags"];
        const tags = Array.isArray(tagsRaw) ? (tagsRaw as string[]) : undefined;

        const task = {
          id,
          title,
          ...(description !== undefined ? { description } : {}),
          owner: { type: ownerType, id: ownerId },
          status,
          ...(tags !== undefined ? { tags } : {}),
        };

        const taskAdapter = Storage.get().task;
        if (!taskAdapter) throw new Error("Task storage not configured");
        taskAdapter.task.set(id, task);

        return successResult(call, JSON.stringify(task));
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

function taskGetTool(): NativeTool {
  return defineTool<{ id: string }>({
    name: "task_get",
    description: "Get a task by ID",
    riskTier: 0,
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
    async execute(call) {
      try {
        const id = requireString(call.input as Record<string, unknown>, "id");
        const taskAdapter = Storage.get().task;
        if (!taskAdapter) throw new Error("Task storage not configured");
        const task = taskAdapter.task.get(id);
        if (!task)
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Task not found: ${id}`,
            isError: true,
          };
        return successResult(call, JSON.stringify(task));
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

function taskListTool(): NativeTool {
  return defineTool<{ status?: string; ownerId?: string }>({
    name: "task_list",
    description: "List tasks with optional filters",
    riskTier: 0,
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        ownerId: { type: "string" },
      },
    },
    async execute(call) {
      try {
        const input = call.input as Record<string, unknown>;
        const status = optionalString(input, "status");
        const ownerId = optionalString(input, "ownerId");

        const taskAdapter = Storage.get().task;
        if (!taskAdapter) throw new Error("Task storage not configured");

        const tasks = taskAdapter.task.list({
          ...(status
            ? {
                status: status as
                  | "idle"
                  | "scheduled"
                  | "running"
                  | "blocked"
                  | "done"
                  | "failed"
                  | "cancelled",
              }
            : {}),
          ...(ownerId ? { ownerId } : {}),
        });

        return successResult(call, JSON.stringify(tasks));
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

function taskUpdateTool(): NativeTool {
  return defineTool<{ id: string; status?: string; title?: string; description?: string }>({
    name: "task_update",
    description: "Update an existing task",
    riskTier: 1,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["id"],
    },
    async execute(call) {
      try {
        const input = call.input as Record<string, unknown>;
        const id = requireString(input, "id");
        const taskAdapter = Storage.get().task;
        if (!taskAdapter) throw new Error("Task storage not configured");

        const existing = taskAdapter.task.get(id);
        if (!existing)
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Task not found: ${id}`,
            isError: true,
          };

        const status = optionalString(input, "status");
        const title = optionalString(input, "title");
        const description = optionalString(input, "description");

        const updated = {
          ...existing,
          ...(status
            ? {
                status: status as
                  | "idle"
                  | "scheduled"
                  | "running"
                  | "blocked"
                  | "done"
                  | "failed"
                  | "cancelled",
              }
            : {}),
          ...(title ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
        };

        taskAdapter.task.set(id, updated);
        return successResult(call, JSON.stringify(updated));
      } catch (err) {
        return fromError(call, err);
      }
    },
  });
}

export class TaskToolProvider implements ToolProvider {
  readonly name = "task";
  readonly category: ToolCategory = "agent";

  listTools(): NativeTool[] {
    return [taskCreateTool(), taskGetTool(), taskListTool(), taskUpdateTool()];
  }

  execute(call: Tool.Call): Promise<Tool.Result> {
    const tool = this.listTools().find((t) => t.spec.name === call.tool);
    if (!tool) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `Unknown tool: ${call.tool}`,
        isError: true,
      });
    }
    return tool.execute(call);
  }
}
