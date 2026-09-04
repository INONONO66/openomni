import { describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/llm";
import { Policy, type Message } from "@openomni/protocol";
import type { Provider } from "@openomni/llm";
import { toModelMessages } from "@openomni/llm/src/message";
import { ChatAgent } from "../../../src/core/chat-agent";
import type { PolicyRegistration } from "../../../src/core/policy";
import { createErrorOutcome, createStopOutcome, type MockLlmFn } from "../../helpers/mock-llm";
import { allow, continueWithPrompt } from "../../helpers/policy-decision";
import { runInput } from "../../helpers/run-input";
import { Bus } from "../../../src/index";

/**
 * C2 (#546): the model must see its own prior tool use. These tests pin the
 * tool-bearing history contract:
 *  1. a turn that used a tool feeds the tool call + result into the next
 *     turn's model input,
 *  2. a plain-stop turn appends its assistant message to history,
 *  3. agent-level retry preserves history and accumulates budget/usage.
 */

const providerModel = {
  id: "claude-3-haiku-20240307",
  name: "Claude 3 Haiku",
  providerID: "anthropic",
  api: { npm: "@ai-sdk/anthropic" },
} as Provider.Model;

const TOKENS_TURN_1 = { input: 100, output: 50 };

function createAgent(run: MockLlmFn, middleware: PolicyRegistration[]) {
  return ChatAgent.create({
    events: Bus,
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    llm: { run, resolveProviderModel: async () => providerModel },
    middleware,
  });
}

function assistantInfo(id: string, sessionID: string, parentID: string): Message.AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: providerModel.id,
    providerID: providerModel.providerID,
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

/**
 * Emits fold-boundary snapshots the way the llm processor does (#557):
 * immutable WithParts states at part boundaries, tokens arriving once at
 * message.finished. The turn contains one completed tool call plus text.
 */
function emitToolTurn(sink: Sink, messageId: string, sessionID: string, parentID: string): void {
  const info = assistantInfo(messageId, sessionID, parentID);
  const toolPart: Message.ToolPart = {
    id: `${messageId}-tool`,
    sessionID,
    messageID: messageId,
    type: "tool",
    callID: "call-1",
    tool: "lookup",
    state: {
      status: "completed",
      input: { q: "answer" },
      output: "42",
      title: "lookup",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  const textPart: Message.TextPart = {
    id: `${messageId}-text`,
    sessionID,
    messageID: messageId,
    type: "text",
    text: "The answer is 42.",
    time: { start: 2, end: 3 },
  };
  sink.onMessage({ info, parts: [toolPart] });
  sink.onMessage({ info, parts: [toolPart, textPart] });
  sink.onMessage({
    info: {
      ...info,
      time: { ...info.time, completed: Date.now() },
      finish: "stop",
      tokens: {
        input: TOKENS_TURN_1.input,
        output: TOKENS_TURN_1.output,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [toolPart, textPart],
  });
}

function emitTextTurn(sink: Sink, messageId: string, sessionID: string, parentID: string): void {
  const info = assistantInfo(messageId, sessionID, parentID);
  const textPart: Message.TextPart = {
    id: `${messageId}-text`,
    sessionID,
    messageID: messageId,
    type: "text",
    text: "done",
    time: { start: 1, end: 2 },
  };
  sink.onMessage({ info, parts: [textPart] });
  sink.onMessage({
    info: { ...info, time: { ...info.time, completed: Date.now() }, finish: "stop" },
    parts: [textPart],
  });
}

/** A finished assistant snapshot with NO text part: a real text-less turn. */
function emitEmptyTurn(sink: Sink, messageId: string, sessionID: string, parentID: string): void {
  const info = assistantInfo(messageId, sessionID, parentID);
  sink.onMessage({ info, parts: [] });
  sink.onMessage({
    info: { ...info, time: { ...info.time, completed: Date.now() }, finish: "stop" },
    parts: [],
  });
}

function sessionAndParent(messages: Message.WithParts[]): { sessionID: string; parentID: string } {
  return {
    sessionID: messages[0]?.info.sessionID ?? "test",
    parentID: messages.at(-1)?.info.id ?? "",
  };
}

function injectOnceMiddleware(): PolicyRegistration {
  let injected = false;
  return {
    kind: "point",
    name: "test:inject-once",
    pointIds: ["run.turn.post"],
    effectCapabilities: { "run.turn.post": ["run.continue_with_prompt"] },
    priority: 100,
    fn: () => {
      if (injected) return allow();
      injected = true;
      return continueWithPrompt("keep going");
    },
  };
}

describe("tool-bearing history (#546)", () => {
  it("feeds a prior turn's tool call and result into the next turn's model input", async () => {
    const capturedInputs: Message.WithParts[][] = [];
    let call = 0;
    const run: MockLlmFn = async (input, sink) => {
      call += 1;
      const messages = input.messages as Message.WithParts[];
      capturedInputs.push([...messages]);
      const { sessionID, parentID } = sessionAndParent(messages);
      if (call === 1) {
        emitToolTurn(sink, "msg-turn-1", sessionID, parentID);
      } else {
        emitTextTurn(sink, `msg-turn-${call}`, sessionID, parentID);
      }
      return createStopOutcome();
    };

    const agent = createAgent(run, [injectOnceMiddleware()]);

    const result = await agent.run(runInput([{ role: "user", content: "what is the answer?" }]));

    expect(result.finishReason).toBe("stop");
    expect(capturedInputs).toHaveLength(2);

    // The next turn's model input (what toModelMessages receives) carries the
    // full assistant WithParts including the tool part.
    const second = capturedInputs[1] ?? [];
    const assistantEntry = second.find((m) => m.info.role === "assistant");
    expect(assistantEntry).toBeDefined();
    const toolPart = assistantEntry?.parts.find(
      (part): part is Message.ToolPart => part.type === "tool",
    );
    expect(toolPart?.callID).toBe("call-1");
    expect(toolPart?.state.status).toBe("completed");

    // And the provider messages expand it into tool-call + tool-result blocks.
    const provider = toModelMessages(second, providerModel);
    const toolCallIds = provider
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block) => block.type === "tool-call")
      .map((block) => (block as { toolCallId: string }).toolCallId);
    expect(toolCallIds).toContain("call-1");

    const toolResults = provider
      .filter((m) => m.role === "tool")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block) => block.type === "tool-result") as Array<{
      toolCallId: string;
      output: { type: string; value: string };
    }>;
    expect(toolResults.map((block) => block.toolCallId)).toContain("call-1");
    expect(toolResults.find((block) => block.toolCallId === "call-1")?.output).toEqual({
      type: "text",
      value: "42",
    });
  });

  it("appends the assistant message to history on a plain stop", async () => {
    let finalMessages: Message.WithParts[] | undefined;
    const run: MockLlmFn = async (input, sink) => {
      const messages = input.messages as Message.WithParts[];
      const { sessionID, parentID } = sessionAndParent(messages);
      emitToolTurn(sink, "msg-turn-1", sessionID, parentID);
      return createStopOutcome();
    };

    const agent = createAgent(run, [
      {
        kind: "point",
        name: "test:capture-final-history",
        pointIds: ["run.lifecycle.post"],
        effectCapabilities: { "run.lifecycle.post": [] },
        priority: 100,
        fn: (ctx) => {
          finalMessages = [
            ...((ctx as unknown as { messages: Message.WithParts[] }).messages ?? []),
          ];
          return allow();
        },
      },
    ]);

    const result = await agent.run(runInput([{ role: "user", content: "hello" }]));

    expect(result.finishReason).toBe("stop");
    expect(finalMessages).toBeDefined();
    const last = finalMessages?.at(-1);
    expect(last?.info.role).toBe("assistant");
    // The history entry is the fold-projected snapshot, tool parts included —
    // not a rebuilt text-only message.
    expect(last?.info.id).toBe("msg-turn-1");
    expect(last?.parts.some((part) => part.type === "tool")).toBe(true);
  });

  it("preserves history and accumulates budget/usage across agent retry attempts", async () => {
    const capturedInputs: Message.WithParts[][] = [];
    const preTurnSnapshots: Array<{
      turnCount: number;
      inputTokens: number;
      outputTokens: number;
    }> = [];
    let call = 0;
    const run: MockLlmFn = async (input, sink) => {
      call += 1;
      const messages = input.messages as Message.WithParts[];
      capturedInputs.push([...messages]);
      const { sessionID, parentID } = sessionAndParent(messages);
      if (call === 1) {
        emitToolTurn(sink, "msg-attempt1-turn1", sessionID, parentID);
        return createStopOutcome();
      }
      if (call === 2) {
        return createErrorOutcome("transient failure");
      }
      emitTextTurn(sink, `msg-turn-${call}`, sessionID, parentID);
      return createStopOutcome();
    };

    const agent = createAgent(run, [
      injectOnceMiddleware(),
      {
        kind: "point",
        name: "test:capture-pre-turn",
        pointIds: ["run.turn.pre"],
        effectCapabilities: { "run.turn.pre": [] },
        priority: 100,
        fn: (ctx) => {
          const context = ctx as unknown as {
            turnCount: number;
            usage: { inputTokens: number; outputTokens: number };
          };
          preTurnSnapshots.push({
            turnCount: context.turnCount,
            inputTokens: context.usage.inputTokens,
            outputTokens: context.usage.outputTokens,
          });
          return allow();
        },
      },
      {
        kind: "point",
        name: "test:fast-retry",
        pointIds: ["run.error.error"],
        effectCapabilities: { "run.error.error": ["run.retry_after"] },
        priority: 100,
        fn: () => allow("test.fast-retry", "retry", [{ type: "run.retry_after", delayMs: 1 }]),
      },
    ]);

    const result = await agent.run(runInput([{ role: "user", content: "hello" }]));

    expect(result.finishReason).toBe("stop");
    expect(call).toBe(3);

    // Attempt 2 still sees attempt 1's history: the tool-bearing assistant
    // message and the injected continuation prompt.
    const third = capturedInputs[2] ?? [];
    expect(third.some((m) => m.info.id === "msg-attempt1-turn1")).toBe(true);
    expect(
      third.some((m) => m.parts.some((part) => part.type === "text" && part.text === "keep going")),
    ).toBe(true);

    // Budget/usage accumulate across attempts instead of resetting: at the
    // start of attempt 2 the run has already spent 2 turns and turn 1's tokens.
    expect(preTurnSnapshots).toHaveLength(3);
    expect(preTurnSnapshots[2]).toEqual({
      turnCount: 2,
      inputTokens: TOKENS_TURN_1.input,
      outputTokens: TOKENS_TURN_1.output,
    });
  });
});

describe("tool-bearing history regressions (#546 fix-first)", () => {
  it("turn.finish replace_messages sees the assistant message, so keep-all preserves tool parts", async () => {
    const capturedInputs: Message.WithParts[][] = [];
    let replaced = false;
    let call = 0;
    const run: MockLlmFn = async (input, sink) => {
      call += 1;
      const messages = input.messages as Message.WithParts[];
      capturedInputs.push([...messages]);
      const { sessionID, parentID } = sessionAndParent(messages);
      if (call === 1) {
        emitToolTurn(sink, "msg-turn-1", sessionID, parentID);
      } else {
        emitTextTurn(sink, `msg-turn-${call}`, sessionID, parentID);
      }
      return createStopOutcome();
    };

    const agent = createAgent(run, [
      {
        kind: "point",
        name: "test:replace-keep-all",
        pointIds: ["run.turn.post"],
        effectCapabilities: {
          "run.turn.post": ["run.replace_messages", "run.continue_with_prompt"],
        },
        priority: 100,
        fn: (ctx) => {
          if (replaced) return allow();
          replaced = true;
          // A history-rewriting policy that keeps everything it can see.
          // The dispatch context must already contain the just-finished
          // assistant message, or this "no-op" rewrite silently deletes it.
          const messages = ctx.messages ?? [];
          return allow("test.replace-keep", "replace", [
            Policy.PolicyEffect.parse({ type: "run.replace_messages", messages: [...messages] }),
            { type: "run.continue_with_prompt", prompt: "go on" },
          ]);
        },
      },
    ]);

    const result = await agent.run(runInput([{ role: "user", content: "what is the answer?" }]));

    expect(result.finishReason).toBe("stop");
    expect(capturedInputs).toHaveLength(2);
    const second = capturedInputs[1] ?? [];
    const assistantEntry = second.find((m) => m.info.id === "msg-turn-1");
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry?.parts.some((part) => part.type === "tool")).toBe(true);
  });

  it("injects run.start prompt effects exactly once across agent retries", async () => {
    const capturedInputs: Message.WithParts[][] = [];
    let call = 0;
    const run: MockLlmFn = async (input, sink) => {
      call += 1;
      const messages = input.messages as Message.WithParts[];
      capturedInputs.push([...messages]);
      if (call === 1) return createErrorOutcome("transient failure");
      const { sessionID, parentID } = sessionAndParent(messages);
      emitTextTurn(sink, `msg-turn-${call}`, sessionID, parentID);
      return createStopOutcome();
    };

    const agent = createAgent(run, [
      {
        kind: "point",
        name: "test:run-start-inject",
        pointIds: ["run.lifecycle.pre"],
        effectCapabilities: { "run.lifecycle.pre": ["prompt.inject_message"] },
        priority: 100,
        fn: () =>
          allow("test.pre-run", "inject", [
            { type: "prompt.inject_message", message: "system context" },
          ]),
      },
      {
        kind: "point",
        name: "test:fast-retry",
        pointIds: ["run.error.error"],
        effectCapabilities: { "run.error.error": ["run.retry_after"] },
        priority: 100,
        fn: () => allow("test.fast-retry", "retry", [{ type: "run.retry_after", delayMs: 1 }]),
      },
    ]);

    const result = await agent.run(runInput([{ role: "user", content: "hello" }]));

    expect(result.finishReason).toBe("stop");
    expect(call).toBe(2);
    // Pre-run effects are run-scoped: attempt 2's model input carries the
    // injection exactly once, not once per attempt.
    const second = capturedInputs[1] ?? [];
    const injections = second.filter((m) =>
      m.parts.some((part) => part.type === "text" && part.text === "system context"),
    );
    expect(injections).toHaveLength(1);
  });

  it("does not resurrect the previous turn's text when a stub emits no snapshot", async () => {
    let finalMessages: Message.WithParts[] | undefined;
    let call = 0;
    const run: MockLlmFn = async (input, sink) => {
      call += 1;
      const messages = input.messages as Message.WithParts[];
      const { sessionID, parentID } = sessionAndParent(messages);
      if (call === 1) {
        emitTextTurn(sink, "msg-turn-1", sessionID, parentID);
      }
      // Turn 2: a snapshot-less stub — never drives the sink.
      return createStopOutcome();
    };

    const agent = createAgent(run, [
      injectOnceMiddleware(),
      {
        kind: "point",
        name: "test:capture-final-history",
        pointIds: ["run.lifecycle.post"],
        effectCapabilities: { "run.lifecycle.post": [] },
        priority: 100,
        fn: (ctx) => {
          finalMessages = [
            ...((ctx as unknown as { messages: Message.WithParts[] }).messages ?? []),
          ];
          return allow();
        },
      },
    ]);

    const result = await agent.run(runInput([{ role: "user", content: "hello" }]));

    expect(result.finishReason).toBe("stop");
    expect(call).toBe(2);
    expect(finalMessages).toBeDefined();
    // The snapshot-less fallback must not duplicate turn 1's "done" text.
    const doneMessages = (finalMessages ?? []).filter((m) =>
      m.parts.some((part) => part.type === "text" && part.text === "done"),
    );
    expect(doneMessages).toHaveLength(1);
    const last = finalMessages?.at(-1);
    expect(last?.info.role).toBe("assistant");
    expect(
      last?.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join(""),
    ).toBe("");
    // Audit M3: the resurrection reached past history — the stale text also
    // came back as the final result.text and as a duplicate step, while
    // history correctly recorded empty. The turn's own (absent) text is the
    // only honest value for all three.
    expect(result.text).toBe("");
    expect(result.steps.map((step) => step.content)).toEqual(["done", ""]);
  });

  /**
   * Audit M3, the non-stub shape: a real continuation turn whose finished
   * snapshot has NO text part. Its step, its run.turn.post text, and the
   * final result.text are this turn's (empty) text — never the previous
   * turn's, which `state.lastAssistantText` still holds.
   */
  it("an empty-text continuation turn does not resurrect the previous turn's text", async () => {
    let call = 0;
    const postTurnTexts: unknown[] = [];
    const run: MockLlmFn = async (input, sink) => {
      call += 1;
      const messages = input.messages as Message.WithParts[];
      const { sessionID, parentID } = sessionAndParent(messages);
      if (call === 1) {
        emitTextTurn(sink, "msg-turn-1", sessionID, parentID);
      } else {
        emitEmptyTurn(sink, "msg-turn-2", sessionID, parentID);
      }
      return createStopOutcome();
    };

    const agent = createAgent(run, [
      injectOnceMiddleware(),
      {
        kind: "point",
        name: "test:capture-turn-result-text",
        pointIds: ["run.turn.post"],
        effectCapabilities: { "run.turn.post": [] },
        priority: 100,
        fn: (ctx) => {
          postTurnTexts.push(
            (ctx as unknown as { turnResult?: { text?: string } }).turnResult?.text,
          );
          return allow();
        },
      },
    ]);

    const result = await agent.run(runInput([{ role: "user", content: "hello" }]));

    expect(result.finishReason).toBe("stop");
    expect(call).toBe(2);
    // The emitted run.turn.post events carry each turn's OWN text: "done"
    // for turn 1, empty for the text-less turn 2 — not "done" twice.
    expect(postTurnTexts).toEqual(["done", ""]);
    expect(result.text).toBe("");
    expect(result.steps.map((step) => step.content)).toEqual(["done", ""]);
  });
});
