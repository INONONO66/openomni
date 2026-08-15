import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";
import { allow, replaceMessages } from "../../helpers/policy-decision";
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

  it("ends on the resource cap when the seam reclaimed nothing", async () => {
    const state = makeState();
    state.messages = [userMessage("u0")];
    const engine = seamEngine(() => allow());
    const turn = makeTurnArtifacts({
      windowYieldArmed: true,
      stepCap: 24,
      turnAssistant: { message: assistantWithSteps(["tool-calls"]) },
    });

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    if (outcome === "continue") throw new Error("expected a terminal result");
    expect(outcome.finishReason).toBe("max-steps");
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
      turnAssistant: { message: assistantWithSteps(["tool-calls", "end_turn"]) },
    });

    const outcome = await handleStop(state, makeConfig(), engine, makeAgentBase(), turn);

    if (outcome === "continue") throw new Error("expected a terminal result");
    expect(outcome.finishReason).toBe("stop");
  });
});
