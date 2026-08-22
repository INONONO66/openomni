import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import { allow, inject, replaceMessages } from "../../helpers/policy-decision";
import {
  dispatchModelRequest,
  dispatchModelResponse,
} from "../../../src/core/execution/lifecycle-dispatch";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

describe("model dispatch points", () => {
  it("dispatches model.request before provider execution", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow());
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-model-request",
      pointIds: ["connection.llm.pre"],
      effectCapabilities: { "connection.llm.pre": [] },
      priority: 100,
      fn,
    });

    const state = makeState();
    const result = await dispatchModelRequest(state, engine, makeConfig(), makeAgentBase(), "test-model");

    expect(result.blocked).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]?.[0] as PolicyContext | undefined;
    expect(ctx?.timing).toBe("model.request");
  });

  it("dispatches model.response after provider execution and exposes outcome type", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow("test.model-response", "observe-response"));
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-model-response",
      pointIds: ["connection.llm.post"],
      effectCapabilities: { "connection.llm.post": [] },
      priority: 100,
      fn,
    });

    const state = makeState();
    state.lastAssistantText = "original";
    const result = await dispatchModelResponse(
      state,
      engine,
      makeConfig(),
      { outcome: { type: "stop" }, responseTokens: 0 },
      makeAgentBase(),
      "test-model",
    );

    expect(result).toBeNull();
    expect(state.lastAssistantText).toBe("original");
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]?.[0] as PolicyContext | undefined;
    expect(ctx?.timing).toBe("model.response");
    expect(ctx?.toolInput?.outcomeType).toBe("stop");
  });

  it("applies model.request prompt injection before provider execution", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-model-request-inject",
      pointIds: ["connection.llm.pre"],
      effectCapabilities: { "connection.llm.pre": ["prompt.inject_message"] },
      priority: 100,
      fn: () => inject("pre-llm context", "test.model-request", "inject"),
    });

    const state = makeState();
    const result = await dispatchModelRequest(state, engine, makeConfig(), makeAgentBase(), "test-model");

    expect(result.blocked).toBeNull();
    const lastMessage = state.messages[state.messages.length - 1];
    const hasInjection = lastMessage?.parts.some(
      (part) => part.type === "text" && part.text === "pre-llm context",
    );
    expect(hasInjection).toBe(true);
  });

  it("applies model.response replacement messages with schema validation", async () => {
    Bus.reset();
    const { createUserMessage } = await import("../../../src/core/message-factory");
    const replacement = [createUserMessage("replacement", "test")];
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-model-response-replace",
      pointIds: ["connection.llm.post"],
      effectCapabilities: { "connection.llm.post": ["run.replace_messages"] },
      priority: 100,
      fn: () => replaceMessages(replacement, "test.model-response", "replace"),
    });

    const state = makeState();
    const result = await dispatchModelResponse(
      state,
      engine,
      makeConfig(),
      { outcome: { type: "stop" }, responseTokens: 0 },
      makeAgentBase(),
      "test-model",
    );

    expect(result).toBeNull();
    expect(state.messages).toEqual(replacement);
  });

  it("blocks model.response malformed replacement messages", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-model-response-bad-replace",
      pointIds: ["connection.llm.post"],
      effectCapabilities: { "connection.llm.post": ["run.replace_messages"] },
      priority: 100,
      fn: () =>
        allow("test.model-response", "bad-replace", [
          { type: "run.replace_messages", messages: [{ invalid: true }] },
        ]),
    });

    const result = await dispatchModelResponse(
      makeState(),
      engine,
      makeConfig(),
      { outcome: { type: "stop" }, responseTokens: 0 },
      makeAgentBase(),
      "test-model",
    );

    expect(result).not.toBeNull();
    expect(result?.guardAborted).toBe(true);
  });
});
