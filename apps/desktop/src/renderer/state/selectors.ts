import {
  activeTab,
  type ClientState,
  consoleStore,
  type Place,
  ROUTE_LABEL,
  type Session,
  type SessionId,
} from "./store";

// Session arrays are immutable store snapshots; derived indexes must not own state or a clock.
const indexes = new WeakMap<readonly Session[], ReadonlyMap<SessionId, Session>>();

export function sessionIndex(sessions: readonly Session[]): ReadonlyMap<SessionId, Session> {
  const existing = indexes.get(sessions);
  if (existing) return existing;
  const index = new Map(sessions.map((session) => [session.id, session]));
  indexes.set(sessions, index);
  return index;
}

export function historyMenuEntries(
  state: ClientState = consoleStore.state,
): readonly { readonly id: string; readonly title: string }[] {
  const tab = activeTab(state);
  if (!tab) return [];
  const { entries, cursor } = tab.history;
  const newestCount = cursor < entries.length - 20 ? 19 : 20;
  return entries
    .flatMap((place, index) =>
      index >= entries.length - newestCount || index === cursor
        ? [{ id: String(index), title: placeTitle(place, state) }]
        : [],
    )
    .reverse();
}

export function placeTitle(place: Place, state: ClientState = consoleStore.state): string {
  switch (place.kind) {
    case "session":
      return sessionIndex(state.sessions).get(place.sessionId)?.title ?? place.sessionId;
    case "route":
      return ROUTE_LABEL[place.route];
  }
}
