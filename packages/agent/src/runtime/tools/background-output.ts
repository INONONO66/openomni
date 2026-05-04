import type { Tool, Subagent } from "@openomni/protocol";

export interface BackgroundOutputToolOptions {
  backgroundManager?: {
    getTask: (taskId: string) => Subagent.BackgroundTask | undefined;
    getResult: (taskId: string) => Subagent.BackgroundTaskResult | undefined;
  };
}

export interface BackgroundOutputToolSpec {
  spec: Tool.Spec;
  execute: (args: unknown) => Promise<Tool.Result>;
}

export namespace BackgroundOutputTool {
  export function create(options?: BackgroundOutputToolOptions): BackgroundOutputToolSpec {
    const spec: Tool.Spec = {
      name: "background_output",
      description:
        "Get output from a background task. Returns immediately with status, or blocks until completion.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "Background task ID",
          },
          block: {
            type: "boolean",
            description: "Wait for completion (default: false)",
          },
          timeout: {
            type: "number",
            description: "Max wait time in ms (default: 60000, max: 300000)",
          },
        },
        required: ["taskId"],
      },
    };

    const execute = async (args: unknown): Promise<Tool.Result> => {
      const { taskId, block, timeout } = args as {
        taskId: string;
        block?: boolean;
        timeout?: number;
      };

      if (!options?.backgroundManager) {
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: "Background execution not available: no BackgroundManager configured",
          isError: true,
        };
      }

      const task = options.backgroundManager.getTask(taskId);
      if (!task) {
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: `Task not found: ${taskId}`,
          isError: true,
        };
      }

      if (block && (task.status === "running" || task.status === "pending")) {
        const deadline = Date.now() + Math.min(timeout ?? 60000, 300000);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          const current = options?.backgroundManager?.getTask(taskId);
          if (current && current.status !== "running" && current.status !== "pending") break;
        }
      }

      const result = options?.backgroundManager?.getResult(taskId);
      if (result?.output) {
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: result.output,
          isError: false,
        };
      }

      const current = options?.backgroundManager?.getTask(taskId);
      const isFailed = current?.status === "failed" || current?.status === "cancelled";
      return {
        id: crypto.randomUUID(),
        toolCallId: "",
        output: isFailed
          ? `Task ${taskId} ${current.status}${current.error ? `: ${current.error}` : ""}`
          : `Task ${taskId} status: ${current?.status ?? "unknown"}`,
        isError: isFailed,
      };
    };

    return { spec, execute };
  }
}
