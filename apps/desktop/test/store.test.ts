import { beforeEach, describe, expect, test } from "bun:test";
import { SIDEBAR_WIDTH } from "@openomni/ui";
import {
  back,
  canGoBack,
  canGoForward,
  consoleStore,
  createSession,
  DEFAULT_PROJECT_ID,
  forward,
  INITIAL_CLIENT_STATE,
  jumpTo,
  navigate,
  setDraft,
  setSidebarFloating,
  setSidebarWidth,
  toggleProject,
  toggleSidebar,
} from "../src/renderer/state/store";

/**
 * The client store's transitions. Small by design: every rule here is one the
 * surface depends on and the compiler cannot see.
 */
beforeEach(() => {
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
});

describe("createSession", () => {
  test("Given an empty store, When a session is created, Then it lands in the default project and is selected", () => {
    const id = createSession(100);
    const { sessions, selectedSessionId } = consoleStore.state;

    expect(sessions).toEqual([
      { id, title: "Session 1", projectId: DEFAULT_PROJECT_ID, createdAt: 100 },
    ]);
    expect(selectedSessionId).toBe(id);
  });

  test("Given existing sessions, When another is created, Then it is numbered after them and takes the selection", () => {
    const first = createSession(1);
    const second = createSession(2);

    expect(first).not.toBe(second);
    expect(consoleStore.state.sessions.map((session) => session.title)).toEqual([
      "Session 1",
      "Session 2",
    ]);
    expect(consoleStore.state.selectedSessionId).toBe(second);
  });
});

describe("selection and groups", () => {
  test("Given two sessions, When the first is selected, Then the selection moves", () => {
    const first = createSession(1);
    createSession(2);
    navigate({ kind: "session", sessionId: first });

    expect(consoleStore.state.selectedSessionId).toBe(first);
  });

  test("Given a project, When toggled twice, Then it is collapsed and then open again", () => {
    toggleProject("p");
    expect(consoleStore.state.collapsedProjectIds.has("p")).toBe(true);

    toggleProject("p");
    expect(consoleStore.state.collapsedProjectIds.has("p")).toBe(false);
  });
});

describe("drafts are per session", () => {
  test("Given two sessions, When one draft is written, Then the other is untouched", () => {
    const first = createSession(1);
    const second = createSession(2);
    setDraft(first, "half a thought");

    expect(consoleStore.state.drafts[first]).toBe("half a thought");
    expect(consoleStore.state.drafts[second]).toBeUndefined();
  });
});

describe("history has browser semantics", () => {
  test("Given three visits, When going back twice and forward once, Then the cursor follows and the column moves", () => {
    const first = createSession(1);
    const second = createSession(2);
    navigate({ kind: "route", route: "inbox" }, 3);

    expect(consoleStore.state.history.entries.map((entry) => entry.title)).toEqual([
      "Session 1",
      "Session 2",
      "Inbox",
    ]);
    back();
    back();
    expect(consoleStore.state.selectedSessionId).toBe(first);
    expect(consoleStore.state.route).toBe("sessions");
    forward();
    expect(consoleStore.state.selectedSessionId).toBe(second);
    expect(canGoBack(consoleStore.state.history)).toBe(true);
    expect(canGoForward(consoleStore.state.history)).toBe(true);
  });

  test("Given a cursor behind the end, When a new place is visited, Then the forward entries are dropped", () => {
    createSession(1);
    createSession(2);
    back();
    navigate({ kind: "route", route: "memory" }, 3);

    expect(consoleStore.state.history.entries.map((entry) => entry.title)).toEqual([
      "Session 1",
      "Memory",
    ]);
    expect(canGoForward(consoleStore.state.history)).toBe(false);
  });

  test("Given the current place, When visited again, Then no entry is added", () => {
    createSession(1);
    navigate({ kind: "route", route: "inbox" }, 2);
    navigate({ kind: "route", route: "inbox" }, 3);

    expect(consoleStore.state.history.entries).toHaveLength(2);
  });

  test("Given an entry id, When jumped to, Then the cursor lands there without pushing", () => {
    const first = createSession(1);
    createSession(2);
    navigate({ kind: "route", route: "automations" }, 3);
    const target = consoleStore.state.history.entries[0];
    if (target === undefined) throw new Error("expected a first entry");

    jumpTo(target.id);
    expect(consoleStore.state.history.cursor).toBe(0);
    expect(consoleStore.state.history.entries).toHaveLength(3);
    expect(consoleStore.state.selectedSessionId).toBe(first);
  });

  test("Given the stack ends, When moving past them, Then nothing changes", () => {
    expect(canGoBack(consoleStore.state.history)).toBe(false);
    back();
    forward();
    expect(consoleStore.state.history.cursor).toBe(-1);
  });
});

describe("the sidebar's width and mode", () => {
  test("Given widths outside the range, When set, Then they are clamped to it", () => {
    setSidebarWidth(SIDEBAR_WIDTH.min - 100);
    expect(consoleStore.state.sidebarWidth).toBe(SIDEBAR_WIDTH.min);
    setSidebarWidth(SIDEBAR_WIDTH.max + 100);
    expect(consoleStore.state.sidebarWidth).toBe(SIDEBAR_WIDTH.max);
    setSidebarWidth(260.4);
    expect(consoleStore.state.sidebarWidth).toBe(260);
  });

  test("Given an open sidebar, When toggled twice, Then it closes and reopens", () => {
    toggleSidebar();
    expect(consoleStore.state.sidebarOpen).toBe(false);
    toggleSidebar();
    expect(consoleStore.state.sidebarOpen).toBe(true);
  });

  test("Given a collapsed sidebar revealed by hover, When toggled, Then it is pinned: open and no longer floating", () => {
    toggleSidebar();
    setSidebarFloating(true);
    expect(consoleStore.state.sidebarFloating).toBe(true);
    toggleSidebar();
    expect(consoleStore.state.sidebarOpen).toBe(true);
    expect(consoleStore.state.sidebarFloating).toBe(false);
  });

  test("Given a floating reveal, When the column arrives anywhere, Then the reveal is dismissed", () => {
    const id = createSession(1);
    toggleSidebar();
    setSidebarFloating(true);
    navigate({ kind: "route", route: "inbox" });
    expect(consoleStore.state.sidebarFloating).toBe(false);
    expect(consoleStore.state.sidebarOpen).toBe(false);

    // The same place again is still an arrival: a row click on the selected
    // session closes the reveal too.
    setSidebarFloating(true);
    navigate({ kind: "session", sessionId: id });
    navigate({ kind: "session", sessionId: id });
    expect(consoleStore.state.sidebarFloating).toBe(false);
    setSidebarFloating(true);
    back();
    expect(consoleStore.state.sidebarFloating).toBe(false);
  });

  test("Given the reveal already in a state, When set to it again, Then the store does not churn", () => {
    const before = consoleStore.state;
    setSidebarFloating(false);
    expect(consoleStore.state).toBe(before);
  });
});
