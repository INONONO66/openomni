import { providerFailure } from "../../helpers/mock-llm";
import { describe, expect, it, jest } from "bun:test";
import { Operational } from "@openomni/protocol";
import { RunEvents } from "../../../src/core/execution/events";
import { runTestAgent } from "../../helpers/test-agent";
import { advanceRunTurn, createRunState, recordRunTurn } from "../../../src/core/execution/state";
import { Bus } from "../../../src/index";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

describe("turn budget across retries", () => {
  it("charges the same turn once and a subsequent turn once", () => {
    const state = createRunState(runInput([{ role: "user", content: "hi" }]));
    recordRunTurn(state);
    recordRunTurn(state);
    expect(state.budgetState.turns).toBe(1);
    advanceRunTurn(state);
    recordRunTurn(state);
    recordRunTurn(state);
    expect(state.budgetState.turns).toBe(2);
  });

  it("reports one charged turn after a successful retry", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const completed = Promise.withResolvers<{ context?: { turns?: number } }>();
    const retry = Promise.withResolvers<void>();
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    const unsubscribeCompleted = Bus.subscribe(Operational.Events.Info, (event) => {
      if (event.msg === "agent.run.completed") completed.resolve(event);
    });
    try {
      const running = runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => {
            calls += 1;
            if (calls === 1) throw providerFailure("transient provider hiccup");
            return createStopOutcome();
          },
        }),
      });
      await retry.promise;
      jest.advanceTimersByTime(1_000);
      expect((await running).finishReason).toBe("stop");
      expect(calls).toBe(2);
      expect((await completed.promise).context?.turns).toBe(1);
    } finally {
      unsubscribeCompleted();
      unsubscribeRetry();
      jest.useRealTimers();
    }
  });
});
