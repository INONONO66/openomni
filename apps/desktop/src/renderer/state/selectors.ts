import {
  activeTab,
  type ClientState,
  consoleStore,
  type Place,
  ROUTE_LABEL,
  type LocalSession,
  type SessionId,
} from "./store";

export function sessionIndex<T extends LocalSession>(
  sessions: readonly T[],
): ReadonlyMap<SessionId, T> {
  return new Map(sessions.map((session) => [session.id, session]));
}

/** Sidebar/Sessions list membership: a session is listed once its first prompt earned a title. */
export function listedSessions<T extends LocalSession>(sessions: readonly T[]): readonly T[] {
  return sessions.filter((session) => session.titleSource === "prompt");
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
