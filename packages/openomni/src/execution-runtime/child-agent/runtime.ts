import type { ToolSelection, TraceContext } from "@openomni/protocol";
import { buildToolCatalog, resolveToolSelection } from "../tool/catalog.js";
import { createToolExecutor } from "../tool/executor.js";
import type { NativeTool } from "../tool/types.js";
import { publishChildAgentStarted } from "./events.js";
import { createDelegationPolicyRuntime, type ResolvedTraceContext } from "./policy.js";
import { settleCancelled, settleCompleted, settleFailed } from "./settlement.js";
import type { ChildAgentRuntime, ChildAgentRuntimeOptions, ChildRecord } from "./types.js";
import {
  DEFAULT_AWAIT_TIMEOUT_MS,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_OUTPUT_CHARS,
  snapshot,
} from "./types.js";

async function dispatchAcceptedDelegationFailure(
  policy: ReturnType<typeof createDelegationPolicyRuntime>,
  childId: string,
  error: unknown,
): Promise<void> {
  await policy.dispatchPost(childId, {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
}

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

/**
 * A child run is the parent's trace with the child's own run id. Both helpers
 * take the parent's resolved context, so neither can be handed a partial one.
 */
function childTraceContext(parent: ResolvedTraceContext, childId: string): TraceContext.Type {
  return { ...parent, runId: childId };
}

function childToolRuntime(
  traceContext: ResolvedTraceContext,
  childId: string,
  workspaceRoot: string | undefined,
) {
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
  const policy = createDelegationPolicyRuntime(options);
  const maxChildren = options.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const awaitTimeoutMs = options.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  let admissionTail = Promise.resolve();

  const cancelRecord = (record: ChildRecord, reason: string): void => {
    if (record.status !== "running") return;
    record.completion = settleCancelled(options, policy, record, new Error(reason));
  };

  const cancelRunningChildren = () => {
    for (const record of records.values()) {
      cancelRecord(record, "parent worker run cancelled");
    }
  };
  options.parentSignal?.addEventListener("abort", cancelRunningChildren, { once: true });

  return {
    async spawn(input) {
      const previousAdmission = admissionTail;
      let releaseAdmission: () => void = () => undefined;
      admissionTail = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      await previousAdmission;

      try {
        if (options.parentSignal?.aborted) {
          throw new Error("parent worker run cancelled");
        }
        const childId = crypto.randomUUID();
        await policy.dispatchPre(childId, {
          name: "child_agent",
          model: options.model,
          prompt: input.prompt,
        });
        if (options.parentSignal?.aborted) {
          const reason = new Error("parent worker run cancelled");
          await policy.dispatchPost(childId, { status: "cancelled", reason: reason.message });
          throw reason;
        }
        let activeChildren = 0;
        for (const record of records.values()) {
          if (record.status === "running") activeChildren += 1;
        }
        if (activeChildren >= maxChildren) {
          const error = new Error(`child agent limit reached: ${maxChildren}`);
          await dispatchAcceptedDelegationFailure(policy, childId, error);
          throw error;
        }
        const controller = new AbortController();
        const record: ChildRecord = {
          id: childId,
          prompt: input.prompt,
          controller,
          status: "running",
          maxOutputChars,
          notifyOnComplete: input.notifyOnComplete === true,
          completion: Promise.resolve(),
        };
        const abortDuringConstruction = () => {
          controller.abort(new Error("parent worker run cancelled"));
        };
        options.parentSignal?.addEventListener("abort", abortDuringConstruction, { once: true });

        let agent: ReturnType<ChildAgentRuntimeOptions["createAgent"]> | undefined;
        try {
          const childTools = selectChildTools(options.parentTools, input.tools);
          if (!controller.signal.aborted) {
            const toolExecutor =
              childTools.length > 0
                ? createToolExecutor({
                    tools: childTools,
                    config: {
                      workspaceRoot: options.workspaceRoot,
                      runtime: childToolRuntime(
                        policy.traceContext,
                        childId,
                        options.workspaceRoot,
                      ),
                    },
                  })
                : undefined;
            agent = options.createAgent({
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
                ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
              })),
              ...(toolExecutor ? { toolExecutor } : {}),
            });
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            options.parentSignal?.removeEventListener("abort", abortDuringConstruction);
            await dispatchAcceptedDelegationFailure(policy, childId, error);
            throw error;
          }
        }

        publishChildAgentStarted(options, record);
        records.set(childId, record);
        options.parentSignal?.removeEventListener("abort", abortDuringConstruction);
        if (controller.signal.aborted || agent === undefined) {
          cancelRecord(record, "parent worker run cancelled");
          return snapshot(record);
        }
        const runCompletion = Promise.resolve()
          .then(() =>
            agent.run({
              messages: [...options.parentMessages, { role: "user", content: input.prompt }],
              traceContext: childTraceContext(policy.traceContext, childId),
            }),
          )
          .then((result) => settleCompleted(options, policy, record, result))
          .catch((error: unknown) => settleFailed(options, policy, record, error));
        record.completion = runCompletion;
        return snapshot(record);
      } finally {
        releaseAdmission();
      }
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
        cancelRecord(record, "child agent cancelled");
      }
      return selected.map(snapshot);
    },

    cancelAll() {
      const selected = [...records.values()].filter((record) => record.status === "running");
      for (const record of selected) {
        cancelRecord(record, "parent worker run finished");
      }
      return selected.map(snapshot);
    },
  };
}
