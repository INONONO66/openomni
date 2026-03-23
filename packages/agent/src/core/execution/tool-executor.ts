import type { Tool } from "@openomni/protocol";

export interface ToolExecutorOptions {
  timeout?: number;
  guard?: (toolName: string) => "allow" | "deny" | "require_approval";
}

export namespace ToolExecutor {
  export async function executeSequential(
    toolCalls: Tool.Call[],
    executor: (call: Tool.Call) => Promise<Tool.Result>,
    options?: ToolExecutorOptions,
  ): Promise<Tool.Result[]> {
    const timeoutMs = options?.timeout ?? 30_000;
    const results: Tool.Result[] = [];

    for (const call of toolCalls) {
      if (options?.guard) {
        const verdict = options.guard(call.tool);
        if (verdict === "deny") {
          results.push({
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Permission denied: tool '${call.tool}' is not allowed`,
            isError: true,
          });
          continue;
        }
        if (verdict === "require_approval") {
          results.push({
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Approval required: tool '${call.tool}' requires human approval`,
            isError: true,
          });
          continue;
        }
      }

      try {
        const result = await withTimeout(executor(call), timeoutMs, call.tool);
        results.push(result);
      } catch (error) {
        results.push({
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
    }

    return results;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool '${toolName}' timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
