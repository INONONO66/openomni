import { providerFailure } from "../helpers/mock-llm";
import { createTestAgent } from "../helpers/test-agent";
import { describe, expect, it, jest } from "bun:test";
import { RunEvents } from "../../src/core/execution/events";
import { stepSnapshot } from "../helpers/messages";
import { Bus } from "../../src/index";
import { completeModel, mockLlm, createStopOutcome } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

describe("mid-turn steering", () => {
  it("yields at a step boundary and continues on the next model call", async () => {
    let pending = true;
    const yielded: Array<boolean | undefined> = [];
    let calls = 0;
    const result = await createTestAgent({
      events: Bus,
      model,
      steeringPending: () => pending,
      llm: mockLlm(async (input, sink) => {
        calls += 1;
        yielded.push(input.shouldYield?.());
        if (calls === 1) {
          pending = false;
          sink.onMessage(stepSnapshot("first", "working", "tool-calls"));
        } else sink.onMessage(stepSnapshot("second", "done", "stop"));
        return createStopOutcome();
      }),
    }).run(runInput([{ role: "user", content: "start" }]));
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("done");
    expect(calls).toBe(2);
    expect(yielded).toEqual([true, false]);
  });

  it("passes no steering callback when steering is absent", async () => {
    let callback: (() => boolean) | undefined;
    await createTestAgent({
      events: Bus,
      model,
      llm: mockLlm(async (input, sink) => {
        callback = input.shouldYield;
        return completeModel(input, sink);
      }),
    }).run(runInput([{ role: "user", content: "start" }]));
    expect(callback).toBeUndefined();
  });

  it("keeps the same turn index when retrying the provider", async () => {
    jest.useFakeTimers();
    const indices: number[] = [];
    const retry = Promise.withResolvers<void>();
    const unsubscribeTurn = Bus.subscribe(RunEvents.TurnStart, (event) =>
      indices.push(event.turnIndex),
    );
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    let calls = 0;
    try {
      const running = createTestAgent({
        events: Bus,
        model,
        llm: mockLlm(async (input, sink) => {
          calls += 1;
          return calls === 1
            ? { type: "error", error: providerFailure("transient blip") }
            : completeModel(input, sink);
        }),
      }).run(runInput([{ role: "user", content: "start" }]));
      await retry.promise;
      jest.advanceTimersByTime(1_000);
      await running;
      expect(indices).toEqual([0, 0]);
    } finally {
      unsubscribeRetry();
      unsubscribeTurn();
      jest.useRealTimers();
    }
  });
});
