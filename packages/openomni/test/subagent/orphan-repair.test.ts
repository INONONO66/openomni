import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message, Tool } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";

function createAssistantMessage(sessionId: string): Message.AssistantMessage {
  return {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "claude-3-haiku-20240307",
    providerID: "anthropic",
    agent: "test",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

beforeEach(() => {
  Storage.reset();
});

afterEach(() => {
  Storage.reset();
});

describe("orphan tool part repair", () => {
  it("serializes pending tool parts as synthetic error when repair=true", async () => {
    const sessionId = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    }).id;

    const assistantMsg = createAssistantMessage(sessionId);
    Session.addMessage(sessionId, assistantMsg);

    const pendingState: Tool.StatePending = {
      status: "pending",
      input: { query: "test" },
    };

    const toolPart: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "tool",
      callID: "call-1",
      tool: "search",
      state: pendingState,
    };

    Session.addPart(assistantMsg.id, toolPart);

    const messages = SubagentRuntime.buildChildMessages(sessionId, true);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.content).toContain(
      "[Tool: search] Error: tool execution interrupted (synthetic)",
    );
  });

  it("serializes running tool parts as synthetic error when repair=true", async () => {
    const sessionId = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    }).id;

    const assistantMsg = createAssistantMessage(sessionId);
    Session.addMessage(sessionId, assistantMsg);

    const runningState: Tool.StateRunning = {
      status: "running",
      input: { query: "test" },
      time: { start: Date.now() },
    };

    const toolPart: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "tool",
      callID: "call-2",
      tool: "compute",
      state: runningState,
    };

    Session.addPart(assistantMsg.id, toolPart);

    const messages = SubagentRuntime.buildChildMessages(sessionId, true);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.content).toContain(
      "[Tool: compute] Error: tool execution interrupted (synthetic)",
    );
  });

  it("serializes pending/running normally when repair=false (default)", async () => {
    const sessionId = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    }).id;

    const assistantMsg = createAssistantMessage(sessionId);
    Session.addMessage(sessionId, assistantMsg);

    const pendingState: Tool.StatePending = {
      status: "pending",
      input: { query: "test" },
    };

    const toolPart: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "tool",
      callID: "call-3",
      tool: "search",
      state: pendingState,
    };

    Session.addPart(assistantMsg.id, toolPart);

    const messages = SubagentRuntime.buildChildMessages(sessionId, false);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.content).toContain("[Tool: search] Input:");
    expect(messages[0]?.content).toContain("Output: (pending)");
    expect(messages[0]?.content).not.toContain("synthetic");
  });

  it("serializes pending/running normally when repair parameter omitted", async () => {
    const sessionId = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    }).id;

    const assistantMsg = createAssistantMessage(sessionId);
    Session.addMessage(sessionId, assistantMsg);

    const runningState: Tool.StateRunning = {
      status: "running",
      input: { query: "test" },
      time: { start: Date.now() },
    };

    const toolPart: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "tool",
      callID: "call-4",
      tool: "compute",
      state: runningState,
    };

    Session.addPart(assistantMsg.id, toolPart);

    const messages = SubagentRuntime.buildChildMessages(sessionId);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.content).toContain("[Tool: compute] Input:");
    expect(messages[0]?.content).toContain("Output: (running)");
    expect(messages[0]?.content).not.toContain("synthetic");
  });

  it("does not modify stored tool part in session", async () => {
    const sessionId = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    }).id;

    const assistantMsg = createAssistantMessage(sessionId);
    Session.addMessage(sessionId, assistantMsg);

    const pendingState: Tool.StatePending = {
      status: "pending",
      input: { query: "test" },
    };

    const toolPart: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "tool",
      callID: "call-5",
      tool: "search",
      state: pendingState,
    };

    Session.addPart(assistantMsg.id, toolPart);

    SubagentRuntime.buildChildMessages(sessionId, true);

    const storedParts = Session.getParts(assistantMsg.id);
    const storedToolPart = storedParts.find((p) => p.type === "tool") as
      | Message.ToolPart
      | undefined;

    expect(storedToolPart).toBeDefined();
    expect(storedToolPart?.state.status).toBe("pending");
  });

  it("handles mixed tool parts (completed, pending, error)", async () => {
    const sessionId = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    }).id;

    const assistantMsg = createAssistantMessage(sessionId);
    Session.addMessage(sessionId, assistantMsg);

    const completedState: Tool.StateCompleted = {
      status: "completed",
      input: { query: "test" },
      output: "result",
      title: "search",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    };

    const pendingState: Tool.StatePending = {
      status: "pending",
      input: { query: "test2" },
    };

    const errorState: Tool.StateError = {
      status: "error",
      input: { query: "test3" },
      error: "failed",
      time: { start: Date.now(), end: Date.now() },
    };

    const completedPart: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "tool",
      callID: "call-6",
      tool: "search",
      state: completedState,
    };

    const pendingPart: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "tool",
      callID: "call-7",
      tool: "compute",
      state: pendingState,
    };

    const errorPart: Message.ToolPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "tool",
      callID: "call-8",
      tool: "fetch",
      state: errorState,
    };

    Session.addPart(assistantMsg.id, completedPart);
    Session.addPart(assistantMsg.id, pendingPart);
    Session.addPart(assistantMsg.id, errorPart);

    const messages = SubagentRuntime.buildChildMessages(sessionId, true);

    expect(messages).toHaveLength(1);
    const content = messages[0]?.content || "";

    expect(content).toContain("[Tool: search] Input:");
    expect(content).toContain("Output: result");

    expect(content).toContain("[Tool: compute] Error: tool execution interrupted (synthetic)");

    expect(content).toContain("[Tool: fetch] Input:");
    expect(content).toContain("Output: failed");
  });
});
