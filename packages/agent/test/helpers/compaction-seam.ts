import { createRunState, recordCallContext, type RunState } from "../../src/core/execution/state";
import { resolveCompactionGeometry } from "../../src/compaction/geometry";
import { applyCompaction } from "../../src/core/execution/turn-compaction";
import type { CompactionSession } from "../../src/compaction/speculate";
import type { ChatAgentConfig } from "../../src/core/types";
import { runInput } from "./run-input";

export function stateAtGrace(window: number, offset: number) {
  const state = createRunState(runInput([{ role: "user", content: "hi" }]));
  recordCallContext(state, resolveCompactionGeometry({ contextWindowTokens: window }).graceTokens + offset);
  return state;
}

export function applyThreshold(state: RunState, config: ChatAgentConfig, session: CompactionSession) {
  return applyCompaction(state, config,
    { traceId: "trace", sessionId: state.sessionId, runId: "run", actorId: "actor" }, session, "threshold");
}
