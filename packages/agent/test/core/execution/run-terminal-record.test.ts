import { providerFailure } from "../../helpers/mock-llm";
import { describe, expect, it, jest } from "bun:test";
import { Operational } from "@openomni/protocol";
import { RunEvents } from "../../../src/core/execution/events";
import { runTestAgent } from "../../helpers/test-agent";
import { Bus } from "../../../src/index";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

function observeRunTerminals() {
  const messages: string[] = [];
  const unsubscribeInfo = Bus.subscribe(Operational.Events.Info, (event) => {
    if (event.msg.startsWith("agent.run.")) messages.push(event.msg);
  });
  const unsubscribeError = Bus.subscribe(Operational.Events.Error, (event) => {
    if (event.msg.startsWith("agent.run.")) messages.push(event.msg);
  });
  return {
    messages,
    unsubscribe: () => {
      unsubscribeError();
      unsubscribeInfo();
    },
  };
}

describe("one terminal record per started run", () => {
  it("records ordinary completion with charged turns", async () => {
    const records = observeRunTerminals();
    const terminal = Promise.withResolvers<{ msg: string; context?: { turns?: number } }>();
    const unsubscribe = Bus.subscribe(Operational.Events.Info, (event) => {
      if (event.msg === "agent.run.completed") terminal.resolve(event);
    });
    try {
      const result = await runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => createStopOutcome(),
        }),
      });
      expect(result.finishReason).toBe("stop");
      expect(await terminal.promise).toMatchObject({
        msg: "agent.run.completed",
        context: { turns: 1 },
      });
      expect(records.messages).toEqual(["agent.run.started", "agent.run.completed"]);
    } finally {
      unsubscribe();
      records.unsubscribe();
    }
  });

  it("records budget error without invoking the model", async () => {
    const records = observeRunTerminals();
    let calls = 0;
    try {
      const result = await runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        budget: { maxTurns: 0 },
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => {
            calls += 1;
            return createStopOutcome();
          },
        }),
      }).catch((error: Error) => error);
      expect(result).toMatchObject({ code: "agent_stop", reason: "budget" });
      expect(calls).toBe(0);
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      records.unsubscribe();
    }
  });

  it("records final classified retry facts at the terminal ceiling", async () => {
    jest.useFakeTimers();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<{
      context?: { reason?: string; attempt?: number; maxAttempts?: number };
    }>();
    let retries = 0;
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, () => {
      retries += 1;
      if (retries === 1) first.resolve();
      else second.resolve();
    });
    const unsubscribeFailed = Bus.subscribe(Operational.Events.Error, (event) => {
      if (event.msg === "agent.run.failed") failed.resolve(event);
    });
    try {
      const running = runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => ({
            type: "error",
            error: providerFailure("connection timeout", { statusCode: 408 }),
          }),
        }),
      });
      await first.promise;
      jest.advanceTimersByTime(1_000);
      await second.promise;
      jest.advanceTimersByTime(2_000);
      await expect(running).rejects.toThrow("connection timeout");
      expect((await failed.promise).context).toEqual({
        reason: "timeout",
        attempt: 3,
        maxAttempts: 3,
      });
    } finally {
      unsubscribeFailed();
      unsubscribeRetry();
      jest.useRealTimers();
    }
  });

  it("records an abort during retry backoff as an interrupt rather than provider failure", async () => {
    const records = observeRunTerminals();
    const controller = new AbortController();
    const retry = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<{
      context?: { reason?: string; attempt?: number; maxAttempts?: number };
    }>();
    const unsubscribeRetry = Bus.subscribe(RunEvents.ErrorRetry, () => retry.resolve());
    const unsubscribeFailed = Bus.subscribe(Operational.Events.Error, (event) => {
      if (event.msg === "agent.run.failed") failed.resolve(event);
    });
    try {
      const running = runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        signal: controller.signal,
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => ({
            type: "error",
            error: providerFailure("connection timeout", { statusCode: 408 }),
          }),
        }),
      });
      await retry.promise;
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect((await failed.promise).context).toEqual({
        reason: "aborted",
        attempt: 1,
        maxAttempts: 3,
      });
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      unsubscribeFailed();
      unsubscribeRetry();
      records.unsubscribe();
    }
  });

  it("records aborts without publishing a retry promise", async () => {
    const records = observeRunTerminals();
    const retries: number[] = [];
    const unsubscribe = Bus.subscribe(RunEvents.ErrorRetry, () => retries.push(1));
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        runTestAgent(runInput([{ role: "user", content: "hi" }]), {
          events: Bus,
          model,
          signal: controller.signal,
          llm: createMockLlmConfig({
            getModels: async () => mockProviderData,
            fromModelsDevModel: () => mockProviderModel,
            run: async () => createStopOutcome(),
          }),
        }),
      ).rejects.toThrow("aborted");
      expect(retries).toEqual([]);
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      unsubscribe();
      records.unsubscribe();
    }
  });

  it("preserves a pre-provider non-Error terminal value", async () => {
    const records = observeRunTerminals();
    const failed = Promise.withResolvers<{ error?: string }>();
    const unsubscribe = Bus.subscribe(Operational.Events.Error, (event) => {
      if (event.msg === "agent.run.failed") failed.resolve(event);
    });
    try {
      const running = runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model,
        llm: {
          resolveModel: async () => {
            throw Symbol.for("terminal");
          },
        },
      });
      await expect(running).rejects.toBe(Symbol.for("terminal"));
      expect((await failed.promise).error).toBe("Symbol(terminal)");
      expect(records.messages).toEqual(["agent.run.started", "agent.run.failed"]);
    } finally {
      unsubscribe();
      records.unsubscribe();
    }
  });
});
