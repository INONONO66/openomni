import { Store } from "@tanstack/store";

/**
 * The renderer's CLIENT state: what this window knows that no server told it.
 *
 * One `Store`, four fields, plain functions to change them. There are no
 * slices, reducers, or action types — the state is small enough to read in one
 * screen, and the ceremony would outweigh it. Components read it through
 * `useStore(consoleStore, selector)` so a change to one field re-renders only
 * the components that selected it.
 *
 * Server state — anything the gateway can answer for — does not live here; it
 * goes through `queries.ts`. Sessions are here ONLY because the wire has no
 * session-list method yet: until it does, a session is a thing the Owner
 * created in this window, and this window is its whole record.
 */

export type ProjectId = string;
export type SessionId = string;

/** The project every new session lands in until projects are real. */
export const DEFAULT_PROJECT_ID: ProjectId = "default";

/**
 * One conversation. `projectId` is membership, never position: the sidebar's
 * order is `attention`'s output, so a session cannot be moved by editing it.
 */
export interface Session {
  readonly id: SessionId;
  readonly title: string;
  readonly projectId: ProjectId | null;
  /** Epoch ms. The one fact a locally created session carries. */
  readonly createdAt: number;
}

export interface ClientState {
  readonly sessions: readonly Session[];
  readonly selectedSessionId: SessionId | null;
  /** Project groups the Owner has closed. `null` is the group of unfiled sessions. */
  readonly collapsedProjectIds: ReadonlySet<ProjectId | null>;
  /**
   * Per session, so switching away and back never hands the Owner a
   * half-written message addressed to a different agent.
   */
  readonly drafts: Readonly<Record<SessionId, string>>;
}

export const INITIAL_CLIENT_STATE: ClientState = {
  sessions: [],
  selectedSessionId: null,
  collapsedProjectIds: new Set(),
  drafts: {},
};

export const consoleStore = new Store<ClientState>(INITIAL_CLIENT_STATE);

/**
 * Create a session and select it. Returns the new id so the caller can treat
 * the creation as the focus boundary it is.
 */
export function createSession(now: number = Date.now()): SessionId {
  const id = crypto.randomUUID();
  consoleStore.setState((state) => ({
    ...state,
    sessions: [
      ...state.sessions,
      {
        id,
        title: `Session ${state.sessions.length + 1}`,
        projectId: DEFAULT_PROJECT_ID,
        createdAt: now,
      },
    ],
    selectedSessionId: id,
  }));
  return id;
}

export function selectSession(id: SessionId): void {
  consoleStore.setState((state) => ({ ...state, selectedSessionId: id }));
}

export function toggleProject(id: ProjectId | null): void {
  consoleStore.setState((state) => {
    const collapsed = new Set(state.collapsedProjectIds);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    return { ...state, collapsedProjectIds: collapsed };
  });
}

export function setDraft(id: SessionId, value: string): void {
  consoleStore.setState((state) => ({ ...state, drafts: { ...state.drafts, [id]: value } }));
}
