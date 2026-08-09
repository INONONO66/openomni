import {
  Communication,
  PolicyDecision,
  type Dispatch as DispatchProtocol,
} from "@openomni/protocol";
import { Bus, Session, Storage, WorkerRun } from "@openomni/session";
import type { DispatchPolicyRegistration } from "../../src/dispatch/policy";

export const flushBus = () => new Promise((resolve) => queueMicrotask(resolve));

export function resetDispatchTestState(): void {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
}

export async function createWorkerRunFixture(runId = "run-1", sessionTitle = `${runId}-session`) {
  const session = Session.create({
    title: sessionTitle,
    model: { providerID: "test", modelID: "test" },
  });
  await WorkerRun.create(session.id, { runId, title: runId, prompt: "test" });
  return session;
}

// PendingInteractionStore writes are frozen (#548) — historical rows are
// seeded at the adapter layer, exactly as pre-freeze rows persist on disk.
export function seedPendingInteraction(
  input: Omit<Communication.PendingInteraction.Record, "status" | "createdAt" | "updatedAt"> &
    Partial<Pick<Communication.PendingInteraction.Record, "status" | "createdAt" | "updatedAt">>,
): Communication.PendingInteraction.Record {
  const adapter = Storage.getAdapter().pendingInteraction;
  if (!adapter) throw new Error("pendingInteraction adapter missing");
  const record = Communication.PendingInteraction.Record.parse({
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...input,
  });
  adapter.create(record);
  return record;
}

export function input(action = "resident.ask"): DispatchProtocol.Input {
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
