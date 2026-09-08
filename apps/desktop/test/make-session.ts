import type { Session } from "../src/renderer/state/store";

export function makeSession(overrides: Partial<Session> = {}): Session {
  const createdAt = overrides.createdAt ?? 0;
  return {
    id: "session",
    title: "Session",
    titleSource: "prompt",
    projectId: "default",
    phase: "idle",
    createdAt,
    lastActivityAt: createdAt,
    phaseSince: createdAt,
    unread: false,
    pinned: false,
    snoozedUntil: null,
    ...overrides,
  };
}
