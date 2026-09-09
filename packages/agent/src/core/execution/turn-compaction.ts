import { Compaction, type CompactionSession } from "../../compaction";
import { executeCompaction } from "../../compaction/execute-cut";
import { resolveCompactionGeometry } from "../../compaction/geometry";
import type { ChatAgentConfig } from "../types";
import { applyCompactionMessages, type AgentRunBase, type RunState } from "./state";

type CompactionApplyResult = "compacted" | "deferred" | "none";

function resolvedCompaction(
  state: RunState,
  config: ChatAgentConfig,
): (NonNullable<ChatAgentConfig["compaction"]> & { contextWindowTokens: number }) | undefined {
  if (config.compaction === undefined) return undefined;
  const contextWindowTokens = config.compaction.contextWindowTokens ?? state.contextWindowTokens;
  if (contextWindowTokens === undefined) return undefined;
  return { ...config.compaction, contextWindowTokens };
}

export function prepareCompactionAfterContinue(
  state: RunState,
  config: ChatAgentConfig,
  compaction: CompactionSession | undefined,
): void {
  const options = resolvedCompaction(state, config);
  const measuredTokens = state.lastCallContextTokens;
  if (options === undefined || measuredTokens === undefined || compaction === undefined) return;
  const geometry = compactionGeometry(state, options);
  compaction.prepare(
    state.messages,
    measuredTokens,
    geometry.prepareTokens,
    options.contextWindowTokens,
  );
}

function compactionGeometry(
  state: RunState,
  options: NonNullable<ReturnType<typeof resolvedCompaction>>,
) {
  return resolveCompactionGeometry({
    contextWindowTokens: options.contextWindowTokens,
    ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    ...(state.lastCompactionYield === undefined
      ? {}
      : { previousYield: state.lastCompactionYield }),
  });
}

export async function applyCompaction(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  compaction: CompactionSession | undefined,
  trigger: "threshold" | "yield",
): Promise<CompactionApplyResult> {
  const options = resolvedCompaction(state, config);
  if (options === undefined) return "none";
  const measuredTokens = state.lastCallContextTokens;
  const geometry = compactionGeometry(state, options);
  if (
    trigger === "threshold" &&
    (measuredTokens === undefined ||
      !Compaction.shouldCompact(measuredTokens, options, state.lastCompactionYield))
  )
    return "none";
  if (
    measuredTokens !== undefined &&
    compaction?.inFlight() === true &&
    measuredTokens < geometry.graceTokens
  ) {
    state.lastCompactionDeferred = true;
    return "deferred";
  }

  state.lastCompactionDeferred = undefined;
  const candidate = compaction?.candidate();
  const result = await executeCompaction({
    history: state.messages,
    options,
    identity: agentBase,
    events: config.events,
    executor: config.executor,
    signal: config.signal,
    dispatch: {
      trigger,
      ...(measuredTokens === undefined ? {} : { measuredTokens }),
      ...(candidate === undefined ? {} : { candidate }),
    },
  });
  if (candidate !== undefined) compaction?.consume();
  state.lastCompactionIneffective = result.ineffective;
  if (result.yield !== undefined) state.lastCompactionYield = result.yield;
  if (result.summarizerFailed === true) compaction?.disable();
  if (!result.compacted) return "none";
  applyCompactionMessages(state, result.messages);
  return "compacted";
}
