
import type { ChatFixture as ChatAgentConfig } from "./chat-services";
import { createRunState, recordCallContext, type RunState } from "../../src/core/turn";
import { resolveCompactionGeometry } from "../../src/plugins/compaction/geometry";
import { applyCompaction } from "../../src/core/compaction";
import type { CompactionSession } from "../../src/plugins/compaction/speculate";
import type {} from "../../src/core/types";
import { fixtureCompactionSeam } from "./fixture-compaction";
import { fixtureStopEvidence } from "./chat-services";
import { runInput } from "./run-input";
import { testMessageSource } from "./message-source";
import { testBudget } from "../helpers/approval-policy";

export function stateAtGrace(window: number, offset: number) {
  const state = createRunState(runInput([{ role: "user", content: "hi" }]), testMessageSource());
  recordCallContext(state, resolveCompactionGeometry({ contextWindowTokens: window }).graceTokens + offset);
  return state;
}

export function applyThreshold(state: RunState, config: ChatAgentConfig, session: CompactionSession) {
  return applyCompaction(state, { compactionSeam: fixtureCompactionSeam, stopEvidence: fixtureStopEvidence, ...config, budget: testBudget(config.budget) },
    { traceId: "trace", sessionId: state.sessionId, runId: "run", actorId: "actor" }, session, "threshold");
}
