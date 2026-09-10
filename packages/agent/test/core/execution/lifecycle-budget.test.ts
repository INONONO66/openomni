import { describe, expect, it, jest } from "bun:test";
import { Operational, type Tool } from "@openomni/protocol";
import { runTestAgent, runUserMessage } from "../../helpers/test-agent";
import { createAssistantMessage } from "../../../src/core/message-factory";
import { Bus } from "../../../src/index";
import { collector } from "../../helpers/observation-collector";
import { mockLlm, createStopOutcome, countingStopLlm } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";
import { expectUncalledBudget } from "../../helpers/execution-assertions";

describe("run budget terminal facts", () => {
  it("charges successful and failed tools across turns before the next admission", async () => {
    jest.useFakeTimers();
    const events = collector();
    let modelCalls = 0;
    let executions = 0;
    const toolExecutor = async (call: Tool.Call): Promise<Tool.Result> => {
      executions += 1;
      jest.advanceTimersByTime(executions === 1 ? 4 : 6);
      if (executions === 2) throw new Error("tool failed");
      return {
        id: `result-${call.id}`,
        toolCallId: call.id,
        toolName: call.tool,
        output: "ok",
      };
    };

    try {
      const result = await runTestAgent(runInput([{ role: "user", content: "hi" }]), {
        events,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        budget: {
          maxTurns: -1,
          maxToolCalls: -1,
          maxWallTimeMs: -1,
          maxToolRuntimeMs: 10,
        },
        steeringPending: () => modelCalls < 3,
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            inputSchema: { type: "object" },
            safe: true,
            placement: "host",
            requires: [],
          },
        ],
        toolExecutor,
        llm: mockLlm(async (input, sink) => {
          modelCalls += 1;
          input.shouldYield?.();
          const call = { id: `call-${modelCalls}`, tool: "lookup", input: {} };
          const message = createAssistantMessage("", "", "session");
          sink.onMessage({
            ...message,
            parts: [
              ...message.parts,
              {
                id: `tool-${modelCalls}`,
                sessionID: "session",
                messageID: message.info.id,
                type: "tool",
                callID: call.id,
                tool: call.tool,
                state: { status: "pending", input: call.input },
              },
              {
                id: `step-${modelCalls}`,
                sessionID: "session",
                messageID: message.info.id,
                type: "step-finish",
                reason: "tool-calls",
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
              },
            ],
          });
          return createStopOutcome();
        }),
      }).catch((error: Error) => error);

      expect(result).toMatchObject({ code: "agent_stop", reason: "budget" });
      expect(modelCalls).toBe(2);
      expect(executions).toBe(2);
      expect(events.named(Operational.Events.Warn.name)).toContainEqual(
        expect.objectContaining({
          msg: "budget exceeded: tool wall time",
          context: expect.objectContaining({ toolCalls: 2, toolRuntimeMs: 10 }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports wall-time exhaustion through only the injected sink", async () => {
    const events = collector();
    const busEvents: string[] = [];
    const unsubscribe = Bus.observe((event) => busEvents.push(event.name));
    const provider = countingStopLlm();
    try {
      const result = await runUserMessage({
        events,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        budget: { maxWallTimeMs: 0 },
        llm: provider.llm,
      }, "hi").catch((error: Error) => error);

      expectUncalledBudget(result, provider.calls);
      expect(events.named(Operational.Events.Warn.name)).toHaveLength(1);
      expect(events.named(Operational.Events.Warn.name)[0]).toMatchObject({
        msg: "budget exceeded: wall time",
        context: { type: "exceeded" },
      });
      expect(busEvents).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("correlates the exceeded-budget record to the run identity", async () => {
    const input = runInput([{ role: "user", content: "hi" }]);
    const warning = Promise.withResolvers<{ traceId: string; sessionId?: string; msg: string }>();
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, warning.resolve);
    try {
      await runTestAgent(input, {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        budget: { maxTurns: 0 },
        llm: mockLlm(async () => createStopOutcome()),
      }).catch((error: Error) => error);
      expect(await warning.promise).toMatchObject({
        traceId: input.traceContext.traceId,
        sessionId: input.traceContext.sessionId,
        msg: "budget exceeded: turns",
      });
    } finally {
      unsubscribe();
    }
  });
});
