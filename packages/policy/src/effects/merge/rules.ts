import type {
  ApprovalAccumulator,
  EffectEntry,
  MergedEffect,
  MergeResult,
  PriorityApprovalAccumulator,
  RetryAccumulator,
} from "../types";
import {
  appendPriorityReason,
  appendReason,
  mergeRetry,
  selectPriorityEffect,
} from "./accumulators";
import { appendMergedEffects } from "./output";
import { assertNever, deepMergeRecords } from "../records";
import { collectPostConflicts } from "../conflicts";

export function mergeEntries(entries: readonly EffectEntry[]): MergeResult {
  const merged: MergedEffect[] = [];
  const postConflicts = collectPostConflicts(entries);
  const toolFilters = new Map<string, number>();
  let toolRewrite: { readonly input: Record<string, unknown>; readonly order: number } | undefined;
  let toolOutputRewrite: MergedEffect | undefined;
  let toolSkip: MergedEffect | undefined;
  let toolApproval: ApprovalAccumulator | undefined;
  let runAbort: MergedEffect | undefined;
  let continueWithPrompt: MergedEffect | undefined;
  let retryAfter: RetryAccumulator | undefined;
  let runReplaceMessages: MergedEffect | undefined;
  let delegationConstraints:
    | { readonly constraints: Record<string, unknown>; readonly order: number }
    | undefined;
  let delegationApproval: ApprovalAccumulator | undefined;
  let promptReplace: MergedEffect | undefined;
  let writebackRewrite: MergedEffect | undefined;
  let writebackSuppress: PriorityApprovalAccumulator | undefined;
  let timeout: { readonly timeoutMs: number; readonly order: number } | undefined;
  let workspaceLock: { readonly required: boolean; readonly order: number } | undefined;
  let allowAsserted:
    | { readonly criterionIds: string[]; readonly order: number; readonly priority: number }
    | undefined;

  for (const entry of entries) {
    const { effect } = entry;

    switch (effect.type) {
      case "prompt.append_context":
      case "prompt.inject_message":
      case "audit.annotate":
        merged.push({ effect, order: entry.order, priority: entry.priority });
        break;
      case "prompt.replace":
        promptReplace = selectPriorityEffect(promptReplace, entry);
        break;
      case "tool.filter":
        if (!toolFilters.has(effect.toolPattern)) toolFilters.set(effect.toolPattern, entry.order);
        break;
      case "tool.rewrite_input":
        toolRewrite = {
          input: deepMergeRecords(toolRewrite?.input ?? {}, effect.input),
          order: Math.min(toolRewrite?.order ?? entry.order, entry.order),
        };
        break;
      case "tool.rewrite_output":
        toolOutputRewrite = selectPriorityEffect(toolOutputRewrite, entry);
        break;
      case "tool.skip_invocation":
        toolSkip ??= { effect, order: entry.order, priority: entry.priority };
        break;
      case "tool.require_approval":
        toolApproval = appendReason(toolApproval, effect.reason, entry.order);
        break;
      case "run.abort":
        runAbort ??= { effect, order: entry.order, priority: entry.priority };
        break;
      case "run.continue_with_prompt":
        continueWithPrompt = selectPriorityEffect(continueWithPrompt, entry);
        break;
      case "run.retry_after":
        retryAfter = mergeRetry(retryAfter, effect, entry.order);
        break;
      case "run.replace_messages":
        runReplaceMessages = selectPriorityEffect(runReplaceMessages, entry);
        break;
      case "delegation.set_constraints":
        delegationConstraints = {
          constraints: deepMergeRecords(
            delegationConstraints?.constraints ?? {},
            effect.constraints,
          ),
          order: Math.min(delegationConstraints?.order ?? entry.order, entry.order),
        };
        break;
      case "delegation.require_approval":
        delegationApproval = appendReason(delegationApproval, effect.reason, entry.order);
        break;
      case "writeback.rewrite":
        writebackRewrite = selectPriorityEffect(writebackRewrite, entry);
        break;
      case "writeback.suppress":
        writebackSuppress = appendPriorityReason(
          writebackSuppress,
          effect.reason,
          entry.order,
          entry.priority,
        );
        break;
      case "runtime.set_timeout":
        timeout = {
          timeoutMs: Math.min(timeout?.timeoutMs ?? effect.timeoutMs, effect.timeoutMs),
          order: Math.min(timeout?.order ?? entry.order, entry.order),
        };
        break;
      case "runtime.workspace_lock":
        workspaceLock = {
          required: (workspaceLock?.required ?? false) || effect.required,
          order: Math.min(workspaceLock?.order ?? entry.order, entry.order),
        };
        break;
      case "work.allow_asserted":
        allowAsserted = {
          ...(allowAsserted ?? { criterionIds: [], order: entry.order, priority: entry.priority }),
          order: Math.min(allowAsserted?.order ?? entry.order, entry.order),
          priority: Math.max(allowAsserted?.priority ?? entry.priority, entry.priority),
        };
        for (const criterionId of effect.criterionIds) {
          if (!allowAsserted.criterionIds.includes(criterionId)) {
            allowAsserted.criterionIds.push(criterionId);
          }
        }
        break;
      default:
        assertNever(effect);
    }
  }

  if (allowAsserted !== undefined) {
    merged.push({
      effect: { type: "work.allow_asserted", criterionIds: allowAsserted.criterionIds },
      order: allowAsserted.order,
      priority: allowAsserted.priority,
    });
  }

  appendMergedEffects(merged, {
    promptReplace,
    toolFilters,
    toolRewrite,
    toolOutputRewrite,
    toolSkip,
    toolApproval,
    runAbort,
    continueWithPrompt,
    retryAfter,
    runReplaceMessages,
    delegationConstraints,
    delegationApproval,
    writebackRewrite,
    writebackSuppress,
    timeout,
    workspaceLock,
  });

  return {
    effects: merged.sort((left, right) => left.order - right.order).map(({ effect }) => effect),
    postConflicts,
  };
}
