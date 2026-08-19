import { beforeEach, describe, expect, it } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { createBrainEngine } from "../../src/ingress/engine";
import { ResidentRuntime } from "../../src/resident/runtime";

// #549 completion proof, restated at the #707 brain seam: two engines in one
// process share no state. Every collaborator is construction-injected, so
// nothing an engine is configured with (runtimes, resolvers) can leak into a
// sibling instance. The pre-flip onPolicyDecision observer assertion moved
// with the authority middleware to the gateway router (@openomni/channels) —
// observer isolation is a router-construction concern now, not a brain one.

function residentDeliver(id: string, sessionId: string): Gateway.Deliver {
  return {
    sessionId,
    event: {
      id,
      traceId: "trace-test",
      surface: "tui",
      workspace: "/repo",
      channel: "resident",
      mode: "direct",
      payload: "hello",
      meta: { actor: { role: "user" } },
    },
    decision: {
      traceId: "trace-test",
      time: Date.now(),
      inboundId: id,
      surface: "tui",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId,
      trustTier: "owner",
      inboundTreatment: "full_access",
      reason: "Inbound message routed to the surface session",
      factsUsed: ["wait:none"],
    },
  };
}

function recordingResidentRuntime(runs: string[], reply: string) {
  return ResidentRuntime.create({
    runAgent: async () => {
      runs.push(reply);
      return { text: reply, finishReason: "stop" };
    },
  });
}

beforeEach(() => {
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

describe("brain engine instance isolation", () => {
  it("keeps resident runtimes per instance", async () => {
    const runsA: string[] = [];
    const runsB: string[] = [];
    const externalAgentResolver = async () => ({
      model: { provider: "test", id: "test-model" },
    });
    const engineA = createBrainEngine({
      residentRuntime: recordingResidentRuntime(runsA, "engine-a"),
      externalAgentResolver,
    });
    const engineB = createBrainEngine({
      residentRuntime: recordingResidentRuntime(runsB, "engine-b"),
      externalAgentResolver,
    });

    const first = await engineA.deliver(residentDeliver("evt-observer-a", crypto.randomUUID()));
    const second = await engineB.deliver(residentDeliver("evt-observer-b", crypto.randomUUID()));

    // Each engine executed through its own resident runtime — and only its own.
    if (first.kind === "dropped" || second.kind === "dropped") throw new Error("shape");
    expect(first.result.output).toBe("engine-a");
    expect(second.result.output).toBe("engine-b");
    expect(runsA).toEqual(["engine-a"]);
    expect(runsB).toEqual(["engine-b"]);
  });
});
