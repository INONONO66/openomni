import { Effect, type Scope } from "effect";
import type { ExecutionError } from "../../errors";
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
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.suspend(() => {
  const options = resolvedCompaction(state, config);
  const measuredTokens = state.lastCallContextTokens;
  if (options === undefined || measuredTokens === undefined || compaction === undefined) return Effect.void;
  const geometry = compactionGeometry(state, options);
  return compaction.prepare(
    state.messages,
    measuredTokens,
    geometry.prepareTokens,
    options.contextWindowTokens,
  );
  });
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

function deferCompaction(measuredTokens: number | undefined, compaction: CompactionSession | undefined, graceTokens: number): boolean {
  return measuredTokens !== undefined && compaction?.inFlight() === true && measuredTokens < graceTokens;
}

export function applyCompaction(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  compaction: CompactionSession | undefined,
  trigger: "threshold" | "yield",
): Effect.Effect<CompactionApplyResult, ExecutionError> {
  return Effect.gen(function* () {
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
  if (deferCompaction(measuredTokens, compaction, geometry.graceTokens)) return "deferred";

  const candidate = compaction?.candidate();
  const result = yield* executeCompaction({
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
  if (result.summarizerFailed === true && compaction !== undefined) yield* compaction.disable();
  if (!result.compacted) return "none";
  applyCompactionMessages(state, result.messages);
  return "compacted";
  });
}
