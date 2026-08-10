import { beforeEach, describe, expect, it } from "bun:test";
import { PolicyDecision, type Ingress } from "@openomni/protocol";
import { Bus, ChannelGrantStore, Storage } from "@openomni/session";
import { createIngressEngine } from "../../src/ingress/engine";
import { ResidentRuntime } from "../../src/resident/runtime";

// #549 completion proof: two engines in one process share no state. Every
// collaborator is construction-injected, so nothing an engine is configured
// with (policies, observers, runtimes) can leak into a sibling instance.

function directEvent(id: string): Ingress.DirectEvent {
  return {
    id,
    surface: "tui",
    workspace: "/repo",
    channel: "resident",
    mode: "direct",
    payload: "hello",
    meta: { actor: { role: "user" } },
    agent: { model: { provider: "test", id: "test-model" } },
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
  ChannelGrantStore.put({
    id: "grant-tui",
    surface: "tui",
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "act_owner",
  });
});

describe("ingress engine instance isolation", () => {
  it("keeps ingress policies of one engine from governing another", async () => {
    const runsA: string[] = [];
    const runsB: string[] = [];
    const engineA = createIngressEngine({
      residentRuntime: recordingResidentRuntime(runsA, "engine-a"),
      policies: [
        {
          name: "test:deny-engine-a",
          timing: "inbound.receive",
          priority: 0,
          fn: () =>
            PolicyDecision.deny({
              policyId: "test.deny-engine-a",
              reasonCodes: ["engine A denies inbound"],
              effects: [{ type: "run.abort", reason: "engine A denies inbound" }],
            }),
        },
      ],
    });
    const engineB = createIngressEngine({
      residentRuntime: recordingResidentRuntime(runsB, "engine-b"),
    });

    await expect(engineA.ingest(directEvent("evt-isolation-a"))).rejects.toThrow(
      "engine A denies inbound",
    );
    const accepted = await engineB.ingest(directEvent("evt-isolation-b"));

    expect(accepted.result.output).toBe("engine-b");
    expect(runsA).toHaveLength(0);
    expect(runsB).toEqual(["engine-b"]);
  });

  it("keeps runtimes and decision observers per instance", async () => {
    const runsA: string[] = [];
    const runsB: string[] = [];
    const decisionsA: string[] = [];
    const engineA = createIngressEngine({
      residentRuntime: recordingResidentRuntime(runsA, "engine-a"),
      onPolicyDecision: (decision) => {
        decisionsA.push(decision.policyId);
      },
    });
    const engineB = createIngressEngine({
      residentRuntime: recordingResidentRuntime(runsB, "engine-b"),
    });

    const first = await engineA.ingest(directEvent("evt-observer-a"));
    const observedAfterA = decisionsA.length;
    const second = await engineB.ingest(directEvent("evt-observer-b"));

    // Each engine executed through its own resident runtime...
    expect(first.result.output).toBe("engine-a");
    expect(second.result.output).toBe("engine-b");
    expect(runsA).toEqual(["engine-a"]);
    expect(runsB).toEqual(["engine-b"]);
    // ...and engine B's ingest never reached engine A's decision observer.
    expect(observedAfterA).toBeGreaterThan(0);
    expect(decisionsA).toHaveLength(observedAfterA);
  });
});
