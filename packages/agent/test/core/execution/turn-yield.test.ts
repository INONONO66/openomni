import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";
import { abortRun, allow, inject, replaceMessages } from "../../helpers/policy-decision";
import { handleStop } from "../../../src/core/execution/turn";
import {
  makeAgentBase,
  makeConfig,
  makeState,
  makeTurnArtifacts,
} from "./lifecycle-dispatch-fixture";

const sessionID = "yield-session";

function assistantWithSteps(reasons: readonly string[]): Message.WithParts {
  const id = "yield-assistant";
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: "",
      modelID: "m",
      providerID: "p",
      agent: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: reasons.map((reason, index) => ({
      id: `${id}-step-${index}`,
      sessionID,
      messageID: id,
      type: "step-finish" as const,
      reason,
      cost: 0,
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    })),
  };
}

function userMessage(text: string): Message.WithParts {
  const id = `yield-user-${text}`;
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "test",
      model: { providerID: "", modelID: "" },
    },
    parts: [{ id: `${id}-t`, sessionID, messageID: id, type: "text", text }],
  };
}

function seamEngine(decision: () => ReturnType<typeof allow>) {
  const engine = PolicyEngine.create();
  engine.register({
    kind: "point",
    name: "test-compaction-seam",
    pointIds: ["run.completion.pre"],
    effectCapabilities: { "run.completion.pre": ["run.replace_messages"] },
    priority: 900,
    fn: decision,
  });
  return engine;
}

describe("window yield (#649 reachability fix)", () => {
  it("continues with a new turn when the seam reclaimed history", async () => {
    const state = makeState();
    state.messages = [userMessage("u0"), userMessage("u1")];
    const replacement = [userMessage("compacted")];
    const engine = seamEngine(() => replaceMessages(replacement));
    const turn = makeTurnArtifacts({
      windowYieldArmed: true,
      stepCap: 24,
      turnAssistant: { message: assistantWithSteps(["tool-calls"]) },
    });
    const turnBefore = state.turnIndex;

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    expect(outcome).toBe("continue");
    expect(state.compactionCount).toBe(1);
    expect(state.turnIndex).toBe(turnBefore + 1);
  });

  it("disarms and continues when the seam reclaimed nothing — the headroom is real", async () => {
    const state = makeState();
    state.messages = [userMessage("u0")];
    const engine = seamEngine(() => allow());
    const turn = makeTurnArtifacts({
      windowYieldArmed: true,
      stepCap: 24,
      turnAssistant: { message: assistantWithSteps(["tool-calls"]) },
    });

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    expect(outcome).toBe("continue");
    expect(state.windowYieldDisarmed).toBe(true);
    expect(state.compactionCount).toBe(0);
  });

  it("ends honestly at the step cap instead of pretending completion", async () => {
    const state = makeState();
    state.messages = [userMessage("u0")];
    const engine = PolicyEngine.create();
    const turn = makeTurnArtifacts({
      windowYieldArmed: true,
      stepCap: 2,
      turnAssistant: { message: assistantWithSteps(["tool-calls", "tool-calls"]) },
    });

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    if (outcome === "continue") throw new Error("expected a terminal result");
    expect(outcome.finishReason).toBe("max-steps");
    expect(state.compactionCount).toBe(0);
  });

  it("treats a model's own stop exactly as before", async () => {
    const state = makeState();
    state.messages = [userMessage("u0")];
    const engine = PolicyEngine.create();
    const turn = makeTurnArtifacts({
      windowYieldArmed: true,
      stepCap: 24,
      turnAssistant: { message: assistantWithSteps(["tool-calls", "stop"]) },
    });

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    if (outcome === "continue") throw new Error("expected a terminal result");
    expect(outcome.finishReason).toBe("stop");
  });

  it("preserves drained injections over the yield — the continuation path wins", async () => {
    // #651 review BLOCKER, reproduced as a pin: run.turn.post drains the
    // injection queue destructively. A yield that early-returned before the
    // continuation application would eat a child's completion notification.
    const state = makeState();
    state.messages = [userMessage("u0")];
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-drain",
      pointIds: ["run.turn.post"],
      effectCapabilities: { "run.turn.post": ["prompt.inject_message"] },
      priority: 100,
      fn: () => inject("child finished"),
    });
    const turn = makeTurnArtifacts({
      windowYieldArmed: true,
      stepCap: 24,
      turnAssistant: { message: assistantWithSteps(["tool-calls"]) },
    });

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    expect(outcome).toBe("continue");
    const texts = state.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "text").map((part) => part.text),
    );
    expect(texts).toContain("child finished");
  });

  it("honors maxToolCalls -1 as unlimited — the cap can never call it a steps yield", async () => {
    const state = makeState();
    state.messages = [userMessage("u0")];
    const engine = seamEngine(() => replaceMessages([userMessage("compacted")]));
    const turn = makeTurnArtifacts({
      windowYieldArmed: true,
      stepCap: Number.MAX_SAFE_INTEGER,
      turnAssistant: {
        message: assistantWithSteps(Array.from({ length: 30 }, () => "tool-calls")),
      },
    });

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    expect(outcome).toBe("continue");
    expect(state.compactionCount).toBe(1);
  });

  it("still terminates on an abort-carrying deny before the yield gets a say", async () => {
    // Re-review observation: the reordering lets a plain (non-abort) deny on a
    // yielded turn fall through to the yield's continue. Abort-denies must
    // keep terminating first — that precedence is the pin.
    const state = makeState();
    state.messages = [userMessage("u0")];
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test-abort-post",
      pointIds: ["run.turn.post"],
      effectCapabilities: { "run.turn.post": ["run.abort"] },
      priority: 100,
      fn: () => abortRun("policy said stop"),
    });
    const turn = makeTurnArtifacts({
      windowYieldArmed: true,
      stepCap: 24,
      turnAssistant: { message: assistantWithSteps(["tool-calls"]) },
    });

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    if (outcome === "continue") throw new Error("expected a terminal result");
    expect(outcome.finishReason).toBe("stop");
    expect(outcome.guardAborted).toBe(true);
  });
});
