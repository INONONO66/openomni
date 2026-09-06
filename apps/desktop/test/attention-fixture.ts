import type { Ordered, ProjectSessionFacts, Signals } from "../src/renderer/attention";
import type { RunState } from "../src/renderer/mock/console";

/**
 * Shared fixture for the attention engine tests.
 *
 * `now` is a literal instant and every fact is expressed as an offset from it,
 * so the ranking these tests assert is reproducible on any machine at any wall
 * time — the whole reason the engine takes `now` as an argument.
 */
export const NOW = Date.parse("2026-09-03T12:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function signals(overrides: Partial<Signals> = {}): Signals {
  return {
    now: NOW,
    activeSessionId: null,
    pins: new Set(),
    snoozes: new Map(),
    lastReadAt: new Map(),
    userBusy: false,
    ...overrides,
  };
}

export function facts(
  id: string,
  state: RunState,
  overrides: Partial<ProjectSessionFacts> = {},
): ProjectSessionFacts {
  return {
    id,
    projectId: "p",
    state,
    lastEventAt: NOW - HOUR,
    lastUserTurnAt: NOW - 2 * HOUR,
    unreadCount: 0,
    ...overrides,
  };
}

export const liveIds = (ordered: Ordered, project = "p"): readonly string[] =>
  ordered.projects.find((group) => group.id === project)?.live.map((entry) => entry.id) ?? [];

export const reasons = (ordered: Ordered, project = "p"): readonly string[] =>
  ordered.projects.find((group) => group.id === project)?.live.map((entry) => entry.reason) ?? [];

export const settledIds = (ordered: Ordered, project = "p"): readonly string[] =>
  ordered.projects.find((group) => group.id === project)?.settled ?? [];
