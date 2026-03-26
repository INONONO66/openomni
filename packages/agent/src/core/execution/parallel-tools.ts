import type { Tool } from "@openomni/protocol";

export type ParallelToolsMode = "off" | "safe-only" | "all";

export interface ParallelExecutorOptions {
  timeout?: number;
  guard?: (toolName: string) => "allow" | "deny" | "require_approval";
  mode?: ParallelToolsMode;
}

/**
 * Executes tool calls with optional parallelism for safe tools.
 *
 * Strategy:
 * - "off": all sequential (current behavior)
 * - "safe-only": safe=true tools run in parallel, unsafe run sequentially after
 * - "all": all tools run in parallel (dangerous, user must opt in)
 *
 * Results are always returned in the original call order.
 */
export namespace ParallelToolExecutor {
  export async function execute(
    toolCalls: Tool.Call[],
    toolSpecs: Tool.Spec[],
    executor: (call: Tool.Call) => Promise<Tool.Result>,
    options?: ParallelExecutorOptions,
  ): Promise<Tool.Result[]> {
    const mode = options?.mode ?? "safe-only";

    if (mode === "off") {
      return executeSequential(toolCalls, executor, options);
    }

    if (mode === "all") {
      return executeAllParallel(toolCalls, executor, options);
    }

    // "safe-only": partition into safe and unsafe
    return executeSafeParallel(toolCalls, toolSpecs, executor, options);
  }

  async function executeSequential(
    toolCalls: Tool.Call[],
    executor: (call: Tool.Call) => Promise<Tool.Result>,
    options?: ParallelExecutorOptions,
  ): Promise<Tool.Result[]> {
    const results: Tool.Result[] = [];
    for (const call of toolCalls) {
      results.push(await executeSingle(call, executor, options));
    }
    return results;
  }

  async function executeAllParallel(
    toolCalls: Tool.Call[],
    executor: (call: Tool.Call) => Promise<Tool.Result>,
    options?: ParallelExecutorOptions,
  ): Promise<Tool.Result[]> {
    return Promise.all(toolCalls.map((call) => executeSingle(call, executor, options)));
  }

  async function executeSafeParallel(
    toolCalls: Tool.Call[],
    toolSpecs: Tool.Spec[],
    executor: (call: Tool.Call) => Promise<Tool.Result>,
    options?: ParallelExecutorOptions,
  ): Promise<Tool.Result[]> {
    // Build a map from tool name → safe flag
    const safeMap = new Map<string, boolean>();
    for (const spec of toolSpecs) {
      safeMap.set(spec.name, spec.safe ?? false);
    }

    // Partition calls into safe and unsafe, preserving original indices
    const safeIndices: number[] = [];
    const unsafeIndices: number[] = [];

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      if (safeMap.get(call.tool) === true) {
        safeIndices.push(i);
      } else {
        unsafeIndices.push(i);
      }
    }

    // Execute safe tools in parallel
    const safeResults = await Promise.all(
      safeIndices.map((idx) => executeSingle(toolCalls[idx], executor, options)),
    );

    // Execute unsafe tools sequentially
    const unsafeResults: Tool.Result[] = [];
    for (const idx of unsafeIndices) {
      unsafeResults.push(await executeSingle(toolCalls[idx], executor, options));
    }

    // Reconstruct results in original order
    const results: Tool.Result[] = new Array(toolCalls.length);
    for (let i = 0; i < safeIndices.length; i++) {
      results[safeIndices[i]] = safeResults[i];
    }
    for (let i = 0; i < unsafeIndices.length; i++) {
      results[unsafeIndices[i]] = unsafeResults[i];
    }

    return results;
  }

  async function executeSingle(
    call: Tool.Call,
    executor: (call: Tool.Call) => Promise<Tool.Result>,
    options?: ParallelExecutorOptions,
  ): Promise<Tool.Result> {
    if (options?.guard) {
      const verdict = options.guard(call.tool);
      if (verdict === "deny") {
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `Permission denied: tool '${call.tool}' is not allowed`,
          isError: true,
        };
      }
      if (verdict === "require_approval") {
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `Approval required: tool '${call.tool}' requires human approval`,
          isError: true,
        };
      }
    }

    const timeoutMs = options?.timeout ?? 30_000;
    try {
      return await withTimeout(executor(call), timeoutMs, call.tool);
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
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
