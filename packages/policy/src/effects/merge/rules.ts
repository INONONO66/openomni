import type { PlainObject, Policy } from "@openomni/protocol";
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
import { deepMergeRecords } from "../records";

type PolicyEffect = Policy.PolicyEffect;
type EffectFamily<Prefix extends string> = Extract<
  PolicyEffect,
  { readonly type: `${Prefix}.${string}` }
>;
type Family =
  | "prompt"
  | "model"
  | "tool"
  | "run"
  | "writeback"
  | "runtime"
  | "audit";

const EFFECT_FAMILY = {
  "prompt.append_context": "prompt",
  "prompt.inject_message": "prompt",
  "prompt.replace": "prompt",
  "model.override": "model",
  "tool.filter": "tool",
  "tool.rewrite_input": "tool",
  "tool.rewrite_output": "tool",
  "tool.skip_invocation": "tool",
  "tool.require_approval": "tool",
  "run.abort": "run",
  "run.continue_with_prompt": "run",
  "run.retry_after": "run",
  "run.replace_messages": "run",
  "writeback.rewrite": "writeback",
  "writeback.suppress": "writeback",
  "runtime.workspace_lock": "runtime",
  "audit.annotate": "audit",
} as const satisfies Record<PolicyEffect["type"], Family>;

interface MergeAccumulators {
  readonly merged: MergedEffect[];
  readonly toolFilters: Map<string, number>;
  toolRewrite?: { readonly input: PlainObject; readonly order: number };
  toolOutputRewrite?: MergedEffect;
  toolSkip?: MergedEffect;
  toolApproval?: ApprovalAccumulator;
  runAbort?: MergedEffect;
  continueWithPrompt?: MergedEffect;
  retryAfter?: RetryAccumulator;
  runReplaceMessages?: MergedEffect;
  promptReplace?: MergedEffect;
  modelOverride?: MergedEffect;
  writebackRewrite?: MergedEffect;
  writebackSuppress?: PriorityApprovalAccumulator;
  workspaceLock?: { readonly required: boolean; readonly order: number };
}

export function foldEffectEntries(entries: readonly EffectEntry[]): MergeResult {
  const state: MergeAccumulators = { merged: [], toolFilters: new Map() };
  for (const entry of entries) mergeEntry(state, entry);
  appendMergedEffects(state.merged, state);
  return {
    effects: state.merged
      .sort((left, right) => left.order - right.order)
      .map(({ effect }) => effect),
  };
}

/** Routes an effect to the fold that owns its policy domain. */
function mergeEntry(state: MergeAccumulators, entry: EffectEntry): void {
  const family: Family = EFFECT_FAMILY[entry.effect.type];
  switch (family) {
    case "prompt":
      mergePromptEffect(state, entry as EffectEntry & { effect: EffectFamily<"prompt"> });
      return;
    case "model":
      state.modelOverride = selectPriorityEffect(state.modelOverride, entry);
      return;
    case "tool":
      mergeToolEffect(state, entry as EffectEntry & { effect: EffectFamily<"tool"> });
      return;
    case "run":
      mergeRunEffect(state, entry as EffectEntry & { effect: EffectFamily<"run"> });
      return;
    case "writeback":
      mergeWritebackEffect(state, entry as EffectEntry & { effect: EffectFamily<"writeback"> });
      return;
    case "runtime":
      mergeRuntimeEffect(state, entry as EffectEntry & { effect: EffectFamily<"runtime"> });
      return;
    case "audit":
      appendImmediate(state, entry);
      return;
  }
}

function appendImmediate(state: MergeAccumulators, entry: EffectEntry): void {
  state.merged.push({ effect: entry.effect, order: entry.order, priority: entry.priority });
}

function mergePromptEffect(
  state: MergeAccumulators,
  entry: EffectEntry & { effect: EffectFamily<"prompt"> },
): void {
  switch (entry.effect.type) {
    case "prompt.append_context":
    case "prompt.inject_message":
      appendImmediate(state, entry);
      return;
    case "prompt.replace":
      state.promptReplace = selectPriorityEffect(state.promptReplace, entry);
      return;
  }
}

function mergeToolEffect(
  state: MergeAccumulators,
  entry: EffectEntry & { effect: EffectFamily<"tool"> },
): void {
  const { effect } = entry;
  switch (effect.type) {
    case "tool.filter":
      if (!state.toolFilters.has(effect.toolPattern)) {
        state.toolFilters.set(effect.toolPattern, entry.order);
      }
      return;
    case "tool.rewrite_input":
      state.toolRewrite = {
        input: deepMergeRecords(state.toolRewrite?.input ?? {}, effect.input),
        order: Math.min(state.toolRewrite?.order ?? entry.order, entry.order),
      };
      return;
    case "tool.rewrite_output":
      state.toolOutputRewrite = selectPriorityEffect(state.toolOutputRewrite, entry);
      return;
    case "tool.skip_invocation":
      state.toolSkip ??= { effect, order: entry.order, priority: entry.priority };
      return;
    case "tool.require_approval":
      state.toolApproval = appendReason(state.toolApproval, effect.reason, entry.order);
      return;
  }
}

function mergeRunEffect(
  state: MergeAccumulators,
  entry: EffectEntry & { effect: EffectFamily<"run"> },
): void {
  const { effect } = entry;
  switch (effect.type) {
    case "run.abort":
      state.runAbort ??= { effect, order: entry.order, priority: entry.priority };
      return;
    case "run.continue_with_prompt":
      state.continueWithPrompt = selectPriorityEffect(state.continueWithPrompt, entry);
      return;
    case "run.retry_after":
      state.retryAfter = mergeRetry(state.retryAfter, effect, entry.order);
      return;
    case "run.replace_messages":
      state.runReplaceMessages = selectPriorityEffect(state.runReplaceMessages, entry);
      return;
  }
}

function mergeWritebackEffect(
  state: MergeAccumulators,
  entry: EffectEntry & { effect: EffectFamily<"writeback"> },
): void {
  const { effect } = entry;
  switch (effect.type) {
    case "writeback.rewrite":
      state.writebackRewrite = selectPriorityEffect(state.writebackRewrite, entry);
      return;
    case "writeback.suppress":
      state.writebackSuppress = appendPriorityReason(
        state.writebackSuppress,
        effect.reason,
        entry.order,
        entry.priority,
      );
      return;
  }
}

function mergeRuntimeEffect(
  state: MergeAccumulators,
  entry: EffectEntry & { effect: EffectFamily<"runtime"> },
): void {
  const { effect } = entry;
  state.workspaceLock = {
    required: (state.workspaceLock?.required ?? false) || effect.required,
    order: Math.min(state.workspaceLock?.order ?? entry.order, entry.order),
  };
}
