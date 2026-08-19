import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { deriveActorContext } from "../../src/dispatch";

describe("deriveActorContext", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("derives worker actor from runtime session and run context", () => {
    const actor = deriveActorContext({ sessionId: "s1", runId: "r1", agentName: "coder" });
    expect(actor.kind).toBe("internal_worker");
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
    expect(deriveActorContext({ agentName: "resident-helper" }).kind).toBe("internal_worker");
    expect(deriveActorContext({ agentName: "task-scheduler-worker" }).kind).toBe("internal_worker");
  });

  test("marks missing dispatch context as unknown", () => {
    const actor = deriveActorContext();
    expect(actor.kind).toBe("unknown");
    expect(actor.reason).toBe("missing dispatch actor context");
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

  // Audit batch A: an unreadable attempt store is NOT "no run". Before the
  // fix the swallowed read error fell through to agentName inference, so an
  // unreadable row plus agentName "resident" derived a privileged kind the
  // dispatch default-authority policy allows.
  test("an unreadable run store derives kind unknown, never an agentName kind", () => {
    // Uninitialized storage makes WorkItemAttemptRun.find throw — the exact
    // read-error shape the swallowing catch used to convert into "absent".
    Storage.reset();
    const actor = deriveActorContext({ sessionId: "s1", runId: "r1", agentName: "resident" });
    expect(actor.kind).toBe("unknown");
    expect(actor.reason).toBe("worker run lookup failed");
    expect(actor.trustTier).toBeUndefined();
  });
});
