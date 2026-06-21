import type { ToolSelection, TraceContext } from "@openomni/protocol";
import { buildToolCatalog, resolveToolSelection } from "../tool/catalog.js";
import { createToolExecutor } from "../tool/executor.js";
import type { NativeTool } from "../tool/types.js";
import type { ChildAgentRuntime, ChildAgentRuntimeOptions, ChildRecord } from "./types.js";
import {
  DEFAULT_AWAIT_TIMEOUT_MS,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_OUTPUT_CHARS,
  snapshot,
} from "./types.js";

function getRecords(
  records: Map<string, ChildRecord>,
  ids: readonly string[] | undefined,
): ChildRecord[] {
  if (!ids || ids.length === 0) return [...records.values()];

  const selected: ChildRecord[] = [];
  for (const id of ids) {
    const record = records.get(id);
    if (!record) throw new Error(`unknown child agent: ${id}`);
    selected.push(record);
  }
  return selected;
}

function childTraceContext(
  parent: TraceContext.Type | undefined,
  childId: string,
): TraceContext.Type | undefined {
  if (!parent) return undefined;
  return { ...parent, runId: childId };
}

function childToolRuntime(
  traceContext: TraceContext.Type | undefined,
  childId: string,
  workspaceRoot: string | undefined,
) {
  if (!traceContext?.sessionId) return undefined;
  return {
    sessionId: traceContext.sessionId,
    runId: childId,
    workspaceRoot,
  };
}

function selectChildTools(
  source: ChildAgentRuntimeOptions["parentTools"],
  selection: ToolSelection.Selection | undefined,
): NativeTool[] {
  const parentTools = typeof source === "function" ? source() : source;
  const catalog = buildToolCatalog(
    parentTools.map((tool) => ({
      source: tool.source ?? "system",
      tools: [tool],
    })),
  );
  const parentAllowed = new Set(parentTools.map((tool) => tool.spec.name));
  return resolveToolSelection(catalog, selection ?? {}, parentAllowed, 1).map(
    (entry) => entry.tool,
  );
}

async function waitForCompletion(
  records: readonly ChildRecord[],
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(records.map((record) => record.completion)),
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`child agent await timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createChildAgentRuntime(options: ChildAgentRuntimeOptions): ChildAgentRuntime {
  const records = new Map<string, ChildRecord>();
  const maxChildren = options.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const awaitTimeoutMs = options.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  const cancelRunningChildren = () => {
    for (const record of records.values()) {
      if (record.status !== "running") continue;
      record.status = "cancelled";
      record.controller.abort(new Error("parent worker run cancelled"));
    }
  };
  options.parentSignal?.addEventListener("abort", cancelRunningChildren, { once: true });

  return {
    spawn(input) {
      let activeChildren = 0;
      for (const record of records.values()) {
        if (record.status === "running") activeChildren += 1;
        if (activeChildren >= maxChildren)
          throw new Error(`child agent limit reached: ${maxChildren}`);
      }
      const childId = crypto.randomUUID();
      const controller = new AbortController();
      const abortFromParent = () => controller.abort(new Error("parent worker run cancelled"));
      options.parentSignal?.addEventListener("abort", abortFromParent, { once: true });
      const childTools = selectChildTools(options.parentTools, input.tools);
      const toolExecutor =
        childTools.length > 0
          ? createToolExecutor({
              tools: childTools,
              config: {
                workspaceRoot: options.workspaceRoot,
                runtime: childToolRuntime(options.traceContext, childId, options.workspaceRoot),
              },
            })
          : undefined;
      const agent = options.createAgent({
        model: options.model,
        systemPrompt: options.systemPrompt,
        signal: controller.signal,
        auth: options.auth,
        allowAuthFallback: options.allowAuthFallback,
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
        ...(options.middleware ? { middleware: options.middleware } : {}),
        tools: childTools.map((tool) => ({
          ...tool.spec,
          name: tool.spec.name.replace(/\./g, "_"),
        })),
        ...(toolExecutor ? { toolExecutor } : {}),
      });

      const record: ChildRecord = {
        id: childId,
        prompt: input.prompt,
        controller,
        status: "running",
        maxOutputChars,
        completion: Promise.resolve(),
      };
      record.completion = agent
        .run({
          messages: [...options.parentMessages, { role: "user", content: input.prompt }],
          traceContext: childTraceContext(options.traceContext, childId),
        })
        .then((result) => {
          options.parentSignal?.removeEventListener("abort", abortFromParent);
          if (record.status === "cancelled") return;
          record.result = result;
          record.status = "completed";
        })
        .catch((error: unknown) => {
          options.parentSignal?.removeEventListener("abort", abortFromParent);
          if (record.status === "cancelled") return;
          record.error = error instanceof Error ? error.message : String(error);
          record.status = "failed";
        });
      records.set(childId, record);
      return snapshot(record);
    },

    inspect(ids) {
      return getRecords(records, ids).map(snapshot);
    },

    async await(ids) {
      const selected = getRecords(records, ids);
      await waitForCompletion(selected, awaitTimeoutMs);
      return selected.map(snapshot);
    },

    cancel(ids) {
      const selected = getRecords(records, ids);
      for (const record of selected) {
        if (record.status === "running") {
          record.status = "cancelled";
          record.controller.abort(new Error("child agent cancelled"));
        }
      }
      return selected.map(snapshot);
    },

    cancelAll() {
      const selected = [...records.values()].filter((record) => record.status === "running");
      for (const record of selected) {
        record.status = "cancelled";
        record.controller.abort(new Error("parent worker run finished"));
      }
      return selected.map(snapshot);
    },
  };
}
