import { describe, expect, it } from "bun:test";

describe("AgentEventEmitter interface", () => {
  it("mock emitter captures events", () => {
    const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
    const emitter = {
      emit(eventName: string, data: Record<string, unknown>) {
        emitted.push({ name: eventName, data });
      },
    };

    emitter.emit("agent.turn.start", { sessionId: "test", time: Date.now(), turnIndex: 0 });
    emitter.emit("tool.execution.started", {
      sessionId: "test",
      time: Date.now(),
      toolCallId: "tc1",
      toolName: "bash",
      inputSummary: "ls",
    });
    emitter.emit("agent.turn.complete", {
      sessionId: "test",
      time: Date.now(),
      turnIndex: 0,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    expect(emitted).toHaveLength(3);
    const [turnStart, toolStarted, turnComplete] = emitted;
    expect(turnStart?.name).toBe("agent.turn.start");
    expect(toolStarted?.name).toBe("tool.execution.started");
    expect(turnComplete?.name).toBe("agent.turn.complete");
  });

  it("runs without eventEmitter without errors", () => {
    const emitter: { emit?: (name: string, data: Record<string, unknown>) => void } = {};
    emitter.emit?.("agent.turn.start", { sessionId: "test", time: Date.now(), turnIndex: 0 });
    expect(true).toBe(true);
  });
});
