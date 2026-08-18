import { PolicyDecision, type Command } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import type { DispatchPolicyRegistration } from "../../src/dispatch/policy-registration";

export const flushBus = () => new Promise((resolve) => queueMicrotask(resolve));

export function resetDispatchTestState(): void {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
}

// The worker-run store is frozen (#510 D2b) — historical rows are seeded at
// the adapter layer, exactly as pre-freeze rows persist on disk (they also
// satisfy the pending_interaction FK on worker_run_state).
export async function createWorkerRunFixture(runId = "run-1", sessionTitle = `${runId}-session`) {
  const session = Session.create({
    traceId: "trace-worker-run-fixture",
    title: sessionTitle,
    model: { providerID: "test", modelID: "test" },
  });
  const adapter = Storage.getAdapter().workerRunState;
  if (!adapter) throw new Error("workerRunState sub-adapter missing");
  adapter.create(session.id, {
    runId,
    agentName: "worker",
    status: "queued",
    executorKind: "internal_chat_agent",
    title: runId,
    prompt: "test",
  });
  return session;
}

export function input(action = "resident.ask"): Command.Input {
  return { action, target: { kind: "resident" }, payload: "hello" };
}

export function allowDispatchPolicy(name = "allow-dispatch"): DispatchPolicyRegistration {
  return {
    kind: "point",
    name,
    pointIds: ["dispatch.action.pre"],
    effectCapabilities: { "dispatch.action.pre": [] },
    priority: 0,
    fn: () => PolicyDecision.allow({ policyId: name }),
  };
}
