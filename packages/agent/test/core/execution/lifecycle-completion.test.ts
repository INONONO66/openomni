import { describe, expect, it, mock } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy/types";
import { registerAt, allow, appendContext, replaceMessages } from "../../helpers/policy-decision";
import { handleCompact } from "../../../src/core/execution/turn";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

describe("completion.prepare dispatch", () => {
  it("completion.prepare replace_messages effect replaces messages in state", async () => {
    Bus.reset();
    const { createUserMessage } = await import("../../../src/core/message-factory");
    const compactedMessages = [createUserMessage("compacted summary", "test")];

    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "run.completion.pre",
      "test-post-compaction",
      100,
      () => replaceMessages(compactedMessages, "test.compact", "compact"),
      ["run.replace_messages"],
    );

    const state = makeState();
    await handleCompact(state, engine, makeConfig(), makeAgentBase());

    expect(state.messages).toEqual(compactedMessages);
    expect(state.compactionCount).toBe(1);
  });

  it("completion.prepare append_context effect appends a user message", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "run.completion.pre",
      "test-post-compaction-context",
      100,
      () => appendContext("compaction context", "test.compact", "append"),
      ["prompt.append_context"],
    );

    const state = makeState();
    const result = await handleCompact(state, engine, makeConfig(), makeAgentBase());

    expect(result).toBe("continue");
    expect(state.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "compaction context" }),
    );
  });

  it("completion.prepare malformed replacement messages fail closed", async () => {
    Bus.reset();
    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "run.completion.pre",
      "test-post-compaction-bad-replacement",
      100,
      () =>
        allow("test.compact", "bad-replace", [
          { type: "run.replace_messages", messages: [{ invalid: true }] },
        ]),
      ["run.replace_messages"],
    );

    const result = await handleCompact(makeState(), engine, makeConfig(), makeAgentBase());

    expect(result).not.toBe("continue");
    if (result === "continue") throw new Error("expected the run to end");
    expect(result.guardAborted).toBe(true);
  });

  it("completion.prepare continue verdict leaves state messages unchanged", async () => {
    Bus.reset();
    const fn = mock((_ctx: PolicyContext) => allow());
    const engine = PolicyEngine.create();
    registerAt(engine, "run.completion.pre", {
      name: "test-post-compaction-noop",
      priority: 100,
      fn,
    });

    const state = makeState();
    const originalMessages = state.messages;
    await handleCompact(state, engine, makeConfig(), makeAgentBase());

    expect(state.messages).toBe(originalMessages);
    expect(state.compactionCount).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
    const ctx = fn.mock.calls[0]?.[0] as PolicyContext;
    expect(ctx.timing).toBe("completion.prepare");
  });
});
