import { runAgent } from "../../src/core/execution/run";
import type { ChatAgentConfig, ChatAgentInput } from "../../src/core/types";
import type { Sink } from "@openomni/llm";
import { createExecutor } from "../../src/executor";
import { recordingLedger } from "./compiled-policy";
import { modelFixture } from "./model-fixture";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";

export function runTestAgent(input: ChatAgentInput, config: ChatAgentConfig, sink?: Sink) {
  return createTestAgent(config).run(input, sink);
}

/** Core tests exercise the shipped executor, not an alternate undurable retry path. */
export function createTestAgent(config: ChatAgentConfig) {
  return {
    run(input: ChatAgentInput, sink?: Sink) {
      const recording = recordingLedger();
      const executor = createExecutor({
        policy: compilePolicySnapshot({
          generation: 1,
          rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
        }),
        ledger: recording.ledger,
        observations: config.events,
        signal: config.signal,
        clock: () => Date.now(),
        entropy: recording.entropy,
        identity: {
          sessionId: input.traceContext?.sessionId ?? "session",
          role: "resident",
          parentActionId: null,
        },
      });
      return runAgent(
        input,
        {
          executor,
          execution: executor,
          ...config,
          ...(config.llm?.run === undefined
            ? {}
            : { llm: { ...config.llm, run: modelFixture(config.llm.run) } }),
        },
        sink,
      );
    },
  };
}
