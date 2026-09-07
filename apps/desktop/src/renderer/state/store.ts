import { clampSidebarWidth, SIDEBAR_WIDTH } from "@openomni/ui";
import { Store } from "@tanstack/store";

/**
 * The renderer's CLIENT state: what this window knows that no server told it.
 *
 * One `Store`, plain functions to change it. There are no slices, reducers, or
 * action types — the state is small enough to read in one screen, and the
 * ceremony would outweigh it. Components read it through
 * `useStore(consoleStore, selector)` so a change to one field re-renders only
 * the components that selected it.
 *
 * Server state — anything the gateway can answer for — does not live here; it
 * goes through `queries.ts`. Sessions are here ONLY because the wire has no
 * session-list method yet: until it does, a session is a thing the Owner
 * created in this window, and this window is its whole record.
 *
 * Where the main column IS goes through ONE action, `navigate`. The sidebar,
 * the tab, ⌘K, and the history menu all call it, so the history stack sees
 * every move and none of them can move the column behind its back.
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

/** The sidebar's destinations. `sessions` is the tree; the rest are routes with nothing in them yet. */
export type Route = "sessions" | "inbox" | "automations" | "memory";

export const ROUTES: readonly Route[] = ["sessions", "inbox", "automations", "memory"];

/** Where the main column can be: on one session, or on a route. */
export type Place =
  | { readonly kind: "session"; readonly sessionId: SessionId }
  | { readonly kind: "route"; readonly route: Route };

/** One entry in the navigation history: a place, what it was called, and when. */
interface HistoryEntry {
  readonly id: string;
  readonly place: Place;
  readonly title: string;
  /** Epoch ms. */
  readonly at: number;
}

export interface History {
  readonly entries: readonly HistoryEntry[];
  /** Index of the current entry; -1 while nothing has been visited. */
  readonly cursor: number;
}

export interface ClientState {
  readonly sessions: readonly Session[];
  readonly selectedSessionId: SessionId | null;
  readonly route: Route;
  /** Project groups the Owner has closed. `null` is the group of unfiled sessions. */
  readonly collapsedProjectIds: ReadonlySet<ProjectId | null>;
  /**
   * Per session, so switching away and back never hands the Owner a
   * half-written message addressed to a different agent.
   */
  readonly drafts: Readonly<Record<SessionId, string>>;
  readonly sidebarOpen: boolean;
  /**
   * Collapsed, but revealed over the main column by hover. Transient by
   * design: it is never persisted, a toggle pins it, and arriving anywhere
   * (`at`) dismisses it — the peek has done its job once a place is chosen.
   */
  readonly sidebarFloating: boolean;
  /** Always within `SIDEBAR_WIDTH`; `setSidebarWidth` clamps. */
  readonly sidebarWidth: number;
  readonly history: History;
}

export const INITIAL_CLIENT_STATE: ClientState = {
  sessions: [],
  selectedSessionId: null,
  route: "sessions",
  collapsedProjectIds: new Set(),
  drafts: {},
  sidebarOpen: true,
  sidebarFloating: false,
  sidebarWidth: SIDEBAR_WIDTH.default,
  history: { entries: [], cursor: -1 },
};

export const consoleStore = new Store<ClientState>(INITIAL_CLIENT_STATE);

/**
 * Create a session and navigate to it. Returns the new id so the caller can
 * treat the creation as the focus boundary it is.
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
  }));
  navigate({ kind: "session", sessionId: id }, now);
  return id;
}

/**
 * Move the main column and record the move. Browser semantics: a new
 * navigation truncates everything forward of the cursor, and the same place
 * twice in a row is one entry, not two.
 */
export function navigate(place: Place, now: number = Date.now()): void {
  consoleStore.setState((state) => {
    const current = state.history.entries[state.history.cursor];
    if (current !== undefined && samePlace(current.place, place)) return at(state, place);
    const kept = state.history.entries.slice(0, state.history.cursor + 1);
    const entry: HistoryEntry = {
      id: `h${kept.length}-${now}`,
      place,
      title: titleOf(state, place),
      at: now,
    };
    return at({ ...state, history: { entries: [...kept, entry], cursor: kept.length } }, place);
  });
}

export function back(): void {
  moveCursor(-1);
}

export function forward(): void {
  moveCursor(1);
}

/** Jump the cursor to one entry (from the history menu) without pushing. */
export function jumpTo(entryId: string): void {
  consoleStore.setState((state) => {
    const index = state.history.entries.findIndex((entry) => entry.id === entryId);
    const entry = state.history.entries[index];
    if (entry === undefined) return state;
    return at({ ...state, history: { ...state.history, cursor: index } }, entry.place);
  });
}

export function canGoBack(history: History): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: History): boolean {
  return history.cursor >= 0 && history.cursor < history.entries.length - 1;
}

function moveCursor(delta: 1 | -1): void {
  consoleStore.setState((state) => {
    const cursor = state.history.cursor + delta;
    const entry = state.history.entries[cursor];
    if (entry === undefined) return state;
    return at({ ...state, history: { ...state.history, cursor } }, entry.place);
  });
}

/** The state with the main column AT a place: the route, and the selection under it. */
function at(state: ClientState, place: Place): ClientState {
  switch (place.kind) {
    case "session":
      return {
        ...state,
        route: "sessions",
        selectedSessionId: place.sessionId,
        sidebarFloating: false,
      };
    case "route":
      return { ...state, route: place.route, sidebarFloating: false };
    default:
      return unreachable(place);
  }
}

function samePlace(a: Place, b: Place): boolean {
  return a.kind === "session" && b.kind === "session"
    ? a.sessionId === b.sessionId
    : a.kind === "route" && b.kind === "route" && a.route === b.route;
}

/** What a history entry is called: the session's title, or the route's label. */
function titleOf(state: ClientState, place: Place): string {
  switch (place.kind) {
    case "session":
      return (
        state.sessions.find((session) => session.id === place.sessionId)?.title ?? place.sessionId
      );
    case "route":
      return ROUTE_LABEL[place.route];
    default:
      return unreachable(place);
  }
}

/** The product's words for its destinations. */
export const ROUTE_LABEL: Record<Route, string> = {
  sessions: "Sessions",
  inbox: "Inbox",
  automations: "Automations",
  memory: "Memory",
};

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

export function setSidebarOpen(open: boolean): void {
  consoleStore.setState((state) => ({ ...state, sidebarOpen: open }));
}

/** Open ↔ collapsed. A toggle while the reveal floats PINS it: open, no longer floating. */
export function toggleSidebar(): void {
  consoleStore.setState((state) => ({
    ...state,
    sidebarOpen: !state.sidebarOpen,
    sidebarFloating: false,
  }));
}

export function setSidebarFloating(floating: boolean): void {
  consoleStore.setState((state) =>
    state.sidebarFloating === floating ? state : { ...state, sidebarFloating: floating },
  );
}

/** Clamped here, so no caller can put an out-of-range width in the store. */
export function setSidebarWidth(width: number): void {
  consoleStore.setState((state) => ({ ...state, sidebarWidth: clampSidebarWidth(width) }));
}

function unreachable(value: never): never {
  throw new Error(`unhandled place: ${JSON.stringify(value)}`);
}
