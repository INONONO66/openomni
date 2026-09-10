import { describe, expect, it } from "bun:test";
import { RunEvents } from "../../../src/core/execution/events";
import { Bus, newTraceId } from "../../../src/index";
import { runTestAgent } from "../../helpers/test-agent";
import type { RunTrace } from "../../../src/core/execution/state";
import { mockLlm, completeModel } from "../../helpers/mock-llm";

// Actor attribution comes only from the validated trace.
async function observedActorId(trace: RunTrace): Promise<string> {
  const actorIds: string[] = [];
  const stop = Bus.observe((event, payload) => {
    if (event.name !== RunEvents.TurnStart.name) return;
    const { actorId } = RunEvents.TurnStart.schema.parse(payload);
    if (actorId !== undefined) actorIds.push(actorId);
  });
  try {
    await runTestAgent(
      {
        messages: [{ role: "user", content: "hi" }],
        traceContext: trace,
      },
      {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        llm: mockLlm(completeModel),
      },
    );
  } finally {
    stop();
  }
  const first = actorIds[0];
  if (first === undefined) throw new Error("no TurnStart observed");
  return first;
}

describe("run actor resolution", () => {
  it("uses trace.agentName when present", async () => {
    const actorId = await observedActorId({
      traceId: newTraceId(),
      sessionId: "session-actor-named",
      runId: "run-actor-named",
      agentName: "named-agent",
    });
    expect(actorId).toBe("named-agent");
  });

  it("falls back to the run identity when agentName is absent", async () => {
    const actorId = await observedActorId({
      traceId: newTraceId(),
      sessionId: "session-actor-anon",
      runId: "run-actor-anon",
    });
    expect(actorId).toBe("run-actor-anon");
  });
});
