import { beforeEach, describe, expect, test } from "bun:test";
import {
  consoleStore,
  createSession,
  DEFAULT_PROJECT_ID,
  INITIAL_CLIENT_STATE,
  selectSession,
  setDraft,
  toggleProject,
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
    selectSession(first);

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
