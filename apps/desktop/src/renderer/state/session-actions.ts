import { consoleStore, type Session, type SessionId, type SessionPhase } from "./store";

export function setSessionPhase(id: SessionId, phase: SessionPhase, now: number): void {
  consoleStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((session) =>
      session.id === id && session.phase !== phase
        ? { ...session, phase, phaseSince: now, lastActivityAt: now }
        : session,
    ),
  }));
}

export function setSessionAttention(
  id: SessionId,
  changes: Partial<Pick<Session, "unread" | "pinned" | "snoozedUntil" | "lastActivityAt">>,
): void {
  consoleStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...changes } : s)),
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

