import { describe, expect, test } from "bun:test";
import { deriveActorContext } from "../../src/dispatch/actor";

describe("deriveActorContext", () => {
  test("derives worker actor from runtime session and run context", () => {
    const actor = deriveActorContext({ sessionId: "s1", runId: "r1", agentName: "coder" });
    expect(actor.kind).toBe("worker");
    expect(actor.actorId).toBe("s1:r1");
    expect(actor.sessionId).toBe("s1");
    expect(actor.runId).toBe("r1");
  });

  test("derives resident actor from resident agent name", () => {
    const actor = deriveActorContext({ sessionId: "s1", runId: "r1", agentName: "resident" });
    expect(actor.kind).toBe("resident");
    expect(actor.runId).toBe("r1");
    expect(actor.workerRunId).toBeUndefined();
    expect(actor.trustTier).toBeUndefined();
  });

  test("does not infer privileged actors from substrings", () => {
    expect(deriveActorContext({ agentName: "resident-helper" }).kind).toBe("worker");
    expect(deriveActorContext({ agentName: "task-scheduler-worker" }).kind).toBe("worker");
  });

  test("marks missing runtime context as unknown", () => {
    const actor = deriveActorContext();
    expect(actor.kind).toBe("unknown");
    expect(actor.reason).toBe("missing runtime actor context");
  });

  test("explicit trusted system context can be supplied by runtime", () => {
    const actor = deriveActorContext({
      actorKind: "system",
      actorId: "system:scheduler",
      trustTier: "manager",
    });
    expect(actor.kind).toBe("system");
    expect(actor.actorId).toBe("system:scheduler");
    expect(actor.trustTier).toBe("manager");
  });
});
