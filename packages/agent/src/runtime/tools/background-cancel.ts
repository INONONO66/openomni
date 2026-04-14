import type { Tool } from "@openomni/protocol";

export interface BackgroundCancelToolOptions {
  backgroundManager?: {
    cancel: (taskId: string) => Promise<boolean> | boolean;
  };
}

export interface BackgroundCancelToolSpec {
  spec: Tool.Spec;
  execute: (args: unknown) => Promise<Tool.Result>;
}

export namespace BackgroundCancelTool {
  export function create(options?: BackgroundCancelToolOptions): BackgroundCancelToolSpec {
    const spec: Tool.Spec = {
      name: "background_cancel",
      description: "Cancel a running background task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "Task ID to cancel",
          },
        },
        required: ["taskId"],
      },
    };

    const execute = async (args: unknown): Promise<Tool.Result> => {
      const { taskId } = args as { taskId: string };

      if (!options?.backgroundManager) {
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: "Background execution not available: no BackgroundManager configured",
          isError: true,
        };
      }

      const cancelled = await options.backgroundManager.cancel(taskId);
      if (cancelled) {
        return {
          id: crypto.randomUUID(),
          toolCallId: "",
          output: `Task ${taskId} cancelled successfully`,
          isError: false,
        };
      }

      return {
        id: crypto.randomUUID(),
        toolCallId: "",
        output: `Task not found or already completed: ${taskId}`,
        isError: true,
      };
    };

    return { spec, execute };
  }
}
