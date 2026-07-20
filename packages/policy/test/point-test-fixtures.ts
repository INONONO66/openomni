export const dispatchContext = {
  actor: { kind: "system", actorId: "system:test" },
  dispatchId: "dispatch-1",
  action: "resident.ask",
  target: { kind: "resident" },
  sessionId: "session-1",
  runId: "run-1",
  marker: { value: "original" },
} as const;
