import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { collector } from "@openomni/telemetry";
import { PolicyRegistry } from "@openomni/agent";
import type { PolicyContext } from "@openomni/agent";
import type { Message } from "@openomni/protocol";
import { registerCompaction } from "../../src/execution-runtime/middleware/compaction-policy";

// Moved from agent's registry.test.ts with the registration itself (#606):
// the config parse and sink injection are this package's wiring now.

function plan(policies: Policy.PolicyPlan["policies"]): Policy.PolicyPlan {
  return { policies, labels: [] };
}

function registry() {
  const instance = PolicyRegistry.create<PolicyContext>();
  return instance;
}

let idCounter = 0;
function userMessage(text: string): Message.WithParts {
  idCounter += 1;
  const id = `reg-msg-${idCounter}`;
  const sessionID = "reg-session";
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "test",
      model: { providerID: "", modelID: "" },
    },
    parts: [{ id: `reg-part-${idCounter}`, sessionID, messageID: id, type: "text", text }],
  };
}

describe("registerCompaction", () => {
  it("resolves a typed plan config", () => {
    const instance = registry();
    registerCompaction(instance, collector());
    const registrations = instance.resolve(
      plan([
        {
          id: "builtin:compaction",
          required: true,
          config: { contextWindowTokens: 1000, thresholdRatio: 0.8 },
        },
      ]),
      {},
    );

    expect(registrations.map((registration) => registration.name)).toEqual(["builtin:compaction"]);
  });

  it("rejects a malformed plan config at resolution", () => {
    // contextWindowTokens is optional since the loop records the model fact —
    // malformed now means wrong type, not absent field.
    const instance = registry();
    registerCompaction(instance, collector());
    expect(() =>
      instance.resolve(
        plan([
          { id: "builtin:compaction", required: true, config: { contextWindowTokens: "wide" } },
        ]),
        {},
      ),
    ).toThrow();
  });

  it("hands the policy the injected sink, and a plan cannot supply its own", async () => {
    const injected = collector();
    const smuggled = collector();
    const instance = registry();
    registerCompaction(instance, injected);
    const registrations = instance.resolve(
      plan([
        {
          id: "builtin:compaction",
          required: true,
          // `events` is not wire config: the schema's output type omits it, so
          // parse drops this. Pinned as an outcome — the injected sink gets the
          // record and the smuggled one stays empty — not as a claim about
          // which layer of the registry produced that outcome.
          config: { contextWindowTokens: 10, protectRecentMessages: 1, events: smuggled },
        },
      ]),
      {},
    );

    const found = registrations.find((r) => r.name === "builtin:compaction");
    // Factory form since L4 (per-run speculator state).
    if (found?.kind !== "factory") throw new Error("expected builtin:compaction factory");
    const compaction = found.create();

    await compaction.fn({
      timing: "turn.finish",
      pointId: "run.completion.pre",
      traceContext: { traceId: "trace-registry-inject" },
      sessionId: "session-registry-inject",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      isCompletion: true,
      continuationCount: 0,
      elapsedMs: 0,
      contextTokens: 900,
      messages: [userMessage("one"), userMessage("two"), userMessage("three")],
    });

    expect(injected.events.length).toBeGreaterThan(0);
    expect(smuggled.events).toHaveLength(0);
  });
});
