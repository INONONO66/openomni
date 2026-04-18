import { Todo } from "@openomni/session";
import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider } from "../types.js";
import { defineTool } from "../define.js";
import { requireString } from "../shared/input.js";
import { successResult, fromError } from "../shared/result.js";

const todoWriteTool = defineTool<{
  sessionId: string;
  todos: Array<{ content: string; status: string; priority: string }>;
}>({
  name: "todo_write",
  description: "Write the current todo list for a session, replacing all existing todos.",
  riskTier: 1,
  implicitInputs: { sessionId: "sessionId" },
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
            },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["content", "status", "priority"],
        },
      },
    },
    required: ["sessionId", "todos"],
  },
  async execute(call) {
    try {
      const sessionId = requireString(call.input, "sessionId");
      const rawTodos = call.input.todos;
      const todos = rawTodos.map((t, i) => ({
        id: crypto.randomUUID(),
        sessionId,
        content: t.content,
        status: t.status as Todo.Info["status"],
        priority: t.priority as Todo.Info["priority"],
        position: i,
      }));
      await Todo.update(sessionId, todos);
      const current = await Todo.get(sessionId);
      return successResult(call, JSON.stringify(current));
    } catch (err) {
      return fromError(call, err);
    }
  },
});

export class TodoToolProvider implements ToolProvider {
  readonly name = "todo";
  readonly category: ToolCategory = "agent";

  listTools(): NativeTool[] {
    return [todoWriteTool];
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
