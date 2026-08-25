import { Delegation } from "@openomni/protocol";

export function buildDelegationRecord(
  overrides: Partial<Delegation.Record> = {},
): Delegation.Record {
  return Delegation.Record.parse({
    delegationId: "delegation-1",
    operation: "ask",
    address: { kind: "actor", actorId: "actor-1" },
    transport: "channel",
    deadline: 10_000,
    waitId: "wait-1",
    rootDelegationId: "delegation-1",
    origin: { role: "resident", depth: 0, sessionId: "session-1" },
    instruction: "Summarize the proposal.",
    status: "open",
    createdAt: 100,
    ...overrides,
  });
}
