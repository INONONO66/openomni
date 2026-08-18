import { describe, expect, it } from "bun:test";
import { Run } from "@openomni/protocol";
import { Bus, newTraceId } from "@openomni/telemetry";
import { runAgent } from "../../../src/core/execution/run";
import type { RunTrace } from "../../../src/core/execution/state";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";

/**
 * Actor resolution order (#606 re-audit): `trace.agentName` when present,
 * otherwise the run identity. The former `input.metadata?.actorId` leg — an
 * unvalidated side-channel with zero producers — is deleted; nothing outside
 * the trace may name the actor.
 */
async function observedActorId(trace: RunTrace): Promise<string> {
  const actorIds: string[] = [];
  const stop = Bus.observe((event, payload) => {
    if (event.name !== Run.Events.TurnStart.name) return;
    actorIds.push((payload as { actorId: string }).actorId);
  });
  try {
    await runAgent(
      // The metadata side-channel is gone from ChatAgentInput entirely —
      // smuggling an actorId through it is now a compile error, not merely
      // ignored at runtime.
      {
        messages: [{ role: "user", content: "hi" }],
        traceContext: trace,
      },
      {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async () => createStopOutcome(),
        }),
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
