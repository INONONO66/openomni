import { consoleStore, type SessionId } from "./store";

export function bindDurableSession(id: SessionId, durableSessionId: string): void {
  consoleStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((session) =>
      session.id === id ? { ...session, durableSessionId } : session,
    ),
  }));
}

export function setSessionTitleIfPlaceholder(id: SessionId, text: string): void {
  const title = Array.from(text.trim()).slice(0, 40).join("");
  if (!title) return;
  consoleStore.setState((state) => {
    const session = state.sessions.find((candidate) => candidate.id === id);
    if (session?.titleSource !== "placeholder") return state;
    return {
      ...state,
      sessions: state.sessions.map((candidate) =>
        candidate.id === id ? { ...candidate, title, titleSource: "prompt" } : candidate,
      ),
    };
  });
}
