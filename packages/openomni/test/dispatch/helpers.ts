import { expect } from "bun:test";
import type { Dispatch } from "@openomni/protocol";
import { Storage } from "@openomni/session";

export function command(
  action: string,
  target: Dispatch.Target,
  payload: unknown = "hello",
): Dispatch.Command {
  return {
    dispatchId: `dispatch-${action}`,
    action,
    target,
    payload,
    actor: { kind: "resident", actorId: "agent:resident", agentName: "resident" },
    traceId: "trace-1",
    submittedAt: Date.now(),
  };
}

export function workerSpawnPayload(text: string): {
  readonly text: string;
  readonly acceptanceCriteria: readonly string[];
} {
  return {
    text,
    acceptanceCriteria: ["The delegated worker returns evidence-backed completion"],
  };
}

export function createSessionFixture(id: string): void {
  const now = Date.now();
  Storage.getAdapter().session.set(id, {
    id,
    title: id,
    model: { providerID: "test", modelID: "test" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  });
}

export async function expectRejectsWithMessage(
  operation: () => unknown,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) return;
    expect(err.message).toContain(message);
    return;
  }
  throw new Error(`Expected operation to reject with ${message}`);
}
