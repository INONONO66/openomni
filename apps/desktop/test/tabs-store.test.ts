import { beforeEach, describe, expect, test } from "bun:test";
import {
  activateTab,
  activateTabAt,
  activeTab,
  back,
  closeTab,
  consoleStore,
  createSession,
  cycleTab,
  forward,
  historyMenuEntries,
  INITIAL_CLIENT_STATE,
  jumpTo,
  navigate,
  openTab,
  reopenClosedTab,
  setDraft,
  setSessionTitleIfPlaceholder,
  setSidebarFloating,
  type Tab,
} from "../src/renderer/state/store";

beforeEach(() => {
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
});

const sessionPlace = (sessionId: string) => ({ kind: "session" as const, sessionId });

function currentTab() {
  const tab = activeTab(consoleStore.state);
  if (!tab) throw new Error("expected an active tab");
  return tab;
}

function openSession(id: string) {
  openTab(sessionPlace(id));
  return currentTab();
}

function collisionTabs() {
  const a = openSession("s1");
  navigate(sessionPlace("s2"));
  navigate(sessionPlace("s3"));
  const b = openSession("s2");
  activateTab(a.id);
  return { a: currentTab(), b };
}

describe("opening and activating", () => {
  test("open appends a fresh single-entry tab and explicit route opens reuse it", () => {
    openTab({ kind: "route", route: "sessions" });
    const first = currentTab();
    expect(first.history).toEqual({ entries: [first.place], cursor: 0 });
    openTab({ kind: "route", route: "inbox" });
    const second = currentTab();
    expect(second.id).not.toBe(first.id);
    expect(consoleStore.state.tabs).toEqual([first, second]);
    openTab(first.place);
    expect(currentTab()).toBe(first);
    expect(consoleStore.state.tabs).toEqual([first, second]);
  });

  test("activation preserves histories and floating reveal, missing id does nothing", () => {
    const first = openSession("s1");
    openSession("s2");
    const tabs = consoleStore.state.tabs;
    setSidebarFloating(true);
    activateTab(first.id);
    expect(consoleStore.state.tabs).toBe(tabs);
    expect(consoleStore.state.sidebarFloating).toBe(true);
    const before = consoleStore.state;
    activateTab("missing");
    activateTab(first.id);
    expect(consoleStore.state).toBe(before);
  });

  test("F1 local Back/Forward/jump round trip permits duplicate current views", () => {
    const { a, b } = collisionTabs();
    back();
    expect(consoleStore.state.activeTabId).toBe(a.id);
    expect(currentTab().place).toEqual(sessionPlace("s2"));
    expect(currentTab().history).toEqual({ entries: a.history.entries, cursor: 1 });
    expect(consoleStore.state.tabs[1]).toBe(b);
    forward();
    expect(consoleStore.state.activeTabId).toBe(a.id);
    expect(currentTab().place).toEqual(sessionPlace("s3"));
    expect(currentTab().history.cursor).toBe(2);
    expect(consoleStore.state.tabs[1]).toBe(b);
    jumpTo(1);
    expect(consoleStore.state.activeTabId).toBe(a.id);
    expect(currentTab().place).toEqual(b.place);
    expect(currentTab().history.cursor).toBe(1);
    expect(consoleStore.state.tabs[1]).toBe(b);
    expect(a.history.cursor).toBe(2);
    expect(consoleStore.state.tabs).toHaveLength(2);
  });

  test("explicit selection prefers target match, then first matching view in strip order", () => {
    const { a, b } = collisionTabs();
    back();
    const tabs = consoleStore.state.tabs;
    navigate(sessionPlace("s2"), b.id);
    expect(consoleStore.state.activeTabId).toBe(b.id);
    expect(consoleStore.state.tabs).toBe(tabs);
    openTab(sessionPlace("s2"));
    expect(consoleStore.state.activeTabId).toBe(b.id);
    const c = openSession("s4");
    navigate(sessionPlace("s2"), c.id);
    expect(consoleStore.state.activeTabId).toBe(a.id);
    expect(consoleStore.state.tabs[2]).toBe(c);
    activateTab(c.id);
    openTab(sessionPlace("s2"));
    expect(consoleStore.state.activeTabId).toBe(a.id);
  });

  test("target-aware search preview reuses B then returns to invocation A for unmatched result", () => {
    const a = openSession("s1");
    const b = openSession("s2");
    activateTab(a.id);
    navigate(b.place, a.id);
    expect(currentTab()).toBe(b);
    expect(consoleStore.state.tabs[0]).toBe(a);
    navigate(sessionPlace("s3"), a.id);
    expect(currentTab().id).toBe(a.id);
    expect(currentTab().history.entries).toEqual([a.place, sessionPlace("s3")]);
    expect(consoleStore.state.tabs[1]).toBe(b);
  });

  test("closed invocation falls back to then-active or opens when empty", () => {
    const a = openSession("s1");
    const b = openSession("s2");
    closeTab(a.id);
    navigate(sessionPlace("s3"), a.id);
    expect(currentTab().id).toBe(b.id);
    closeTab(b.id);
    navigate(sessionPlace("s4"), a.id);
    expect(currentTab().id).not.toBe(a.id);
    expect(currentTab().id).not.toBe(b.id);
    expect(currentTab().history.entries).toEqual([sessionPlace("s4")]);
  });

  test("explicit route navigation changes the target rather than reusing another route tab", () => {
    openTab({ kind: "route", route: "inbox" });
    const first = currentTab();
    const second = openSession("s1");
    navigate(first.place, second.id);
    expect(currentTab().id).toBe(second.id);
    expect(consoleStore.state.tabs[0]).toBe(first);
    expect(currentTab().history.entries).toEqual([second.place, first.place]);
  });
});

describe("closing and reopening", () => {
  test("inactive close preserves active; active close chooses right, then left, then null", () => {
    const a = openSession("s1");
    const b = openSession("s2");
    const c = openSession("s3");
    const d = openSession("s4");
    activateTab(b.id);
    closeTab(a.id);
    expect(currentTab()).toBe(b);
    closeTab(b.id);
    expect(currentTab()).toBe(c);
    closeTab(d.id);
    expect(currentTab()).toBe(c);
    const e = openSession("s5");
    closeTab(e.id);
    expect(currentTab()).toBe(c);
    closeTab(c.id);
    expect(consoleStore.state.tabs).toEqual([]);
    expect(consoleStore.state.activeTabId).toBeNull();
  });

  test("missing close and empty reopen are no-ops", () => {
    const before = consoleStore.state;
    closeTab("missing");
    reopenClosedTab();
    expect(consoleStore.state).toBe(before);
    openSession("s1");
    const populated = consoleStore.state;
    closeTab("missing");
    expect(consoleStore.state).toBe(populated);
  });

  test("close retains session, draft and immutable snapshot", () => {
    const id = createSession(1);
    const tab = openSession(id);
    setDraft(id, "unfinished");
    const before = consoleStore.state;
    closeTab(tab.id);
    expect(consoleStore.state.sessions).toBe(before.sessions);
    expect(consoleStore.state.drafts).toBe(before.drafts);
    expect(consoleStore.state.closedTabs).toEqual([{ tab, index: 0 }]);
    reopenClosedTab();
    navigate({ kind: "route", route: "memory" });
    expect(tab.history.entries).toEqual([sessionPlace(id)]);
    expect(before.tabs).toEqual([tab]);
  });

  test("21 closures retain newest 20 snapshots oldest-first", () => {
    const closed: Tab[] = [];
    for (let index = 0; index < 21; index += 1) {
      const tab = openSession(`s${index}`);
      closed.push(tab);
      closeTab(tab.id);
    }
    expect(consoleStore.state.closedTabs.map(({ tab }) => tab)).toEqual(closed.slice(1));
    expect(consoleStore.state.closedTabs).toHaveLength(20);
    reopenClosedTab();
    expect(closed[20]).toBe(currentTab());
    expect(consoleStore.state.closedTabs).toHaveLength(19);
  });

  test("F2 collision retains snapshot then restores original id, position, cursor and both history sides", () => {
    const { a, b } = collisionTabs();
    back();
    const snapshot = currentTab();
    closeTab(a.id);
    const stack = consoleStore.state.closedTabs;
    reopenClosedTab();
    expect(currentTab()).toBe(b);
    expect(consoleStore.state.closedTabs).toBe(stack);
    navigate(sessionPlace("s4"));
    reopenClosedTab();
    expect(currentTab()).toBe(snapshot);
    expect(consoleStore.state.tabs[0]).toBe(snapshot);
    expect(snapshot.history).toEqual({
      entries: [sessionPlace("s1"), sessionPlace("s2"), sessionPlace("s3")],
      cursor: 1,
    });
    expect(consoleStore.state.closedTabs).toEqual([]);
  });

  test("collision retry remains deferred while another matching session view remains", () => {
    const c = openSession("s2");
    navigate(sessionPlace("s5"));
    const { a, b } = collisionTabs();
    back();
    activateTab(c.id);
    back();
    activateTab(a.id);
    closeTab(a.id);
    const stack = consoleStore.state.closedTabs;
    reopenClosedTab();
    expect(currentTab()).toBe(b);
    navigate(sessionPlace("s4"));
    reopenClosedTab();
    expect(currentTab().id).toBe(c.id);
    expect(consoleStore.state.closedTabs).toBe(stack);
    navigate(sessionPlace("s6"));
    reopenClosedTab();
    expect(currentTab().id).toBe(a.id);
    expect(consoleStore.state.closedTabs).toEqual([]);
  });

  test("restoration clamps saved index to current length", () => {
    const a = openSession("s1");
    openSession("s2");
    const c = openSession("s3");
    consoleStore.setState((state) => ({
      ...state,
      tabs: [a],
      activeTabId: a.id,
      closedTabs: [{ tab: c, index: 2 }],
    }));
    reopenClosedTab();
    expect(consoleStore.state.tabs).toEqual([a, c]);
    expect(currentTab()).toBe(c);
    expect(consoleStore.state.closedTabs).toEqual([]);
  });

  test("route snapshots restore even when another tab already shows the route", () => {
    const a = openSession("s1");
    navigate({ kind: "route", route: "inbox" });
    const snapshot = currentTab();
    closeTab(a.id);
    openTab(snapshot.place);
    const b = currentTab();
    reopenClosedTab();
    expect(consoleStore.state.tabs).toEqual([snapshot, b]);
    expect(currentTab()).toBe(snapshot);
    expect(consoleStore.state.closedTabs).toEqual([]);
  });
});

describe("ordinal selection and positional cycling", () => {
  test("empty strips ignore ordinal and cycle commands", () => {
    const before = consoleStore.state;
    activateTabAt(1);
    activateTabAt(9);
    cycleTab(1);
    cycleTab(-1);
    expect(consoleStore.state).toBe(before);
  });

  test("1..8 select ordinals, 9 selects last beyond nine, invalid values are no-ops", () => {
    const tabs = Array.from({ length: 11 }, (_: undefined, index: number) => openSession(`s${index}`));
    for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
      activateTabAt(ordinal);
      expect(tabs[ordinal - 1]).toBe(currentTab());
    }
    activateTabAt(9);
    expect(tabs[10]).toBe(currentTab());
    const before = consoleStore.state;
    for (const ordinal of [0, -1, 10, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      activateTabAt(ordinal);
    expect(consoleStore.state).toBe(before);
  });

  test("one tab stays active and missing ordinals do nothing", () => {
    openSession("s1");
    const before = consoleStore.state;
    activateTabAt(8);
    activateTabAt(9);
    cycleTab(1);
    cycleTab(-1);
    expect(consoleStore.state).toBe(before);
  });

  test("cycling wraps in strip order rather than activation order", () => {
    const a = openSession("s1");
    const b = openSession("s2");
    const c = openSession("s3");
    activateTab(a.id);
    activateTab(c.id);
    cycleTab(1);
    expect(currentTab()).toBe(a);
    cycleTab(1);
    expect(currentTab()).toBe(b);
    cycleTab(-1);
    expect(currentTab()).toBe(a);
    cycleTab(-1);
    expect(currentTab()).toBe(c);
  });
});

describe("history menu selector", () => {
  test("empty history has no menu entries", () => {
    expect(historyMenuEntries()).toEqual([]);
  });

  test("over 20 visits retain original cursor ids and current plus newest 19", () => {
    for (let index = 0; index < 25; index += 1) navigate(sessionPlace(`s${index}`));
    expect(historyMenuEntries().map(({ id }) => id)).toEqual(
      Array.from({ length: 20 }, (_: undefined, index: number) => String(24 - index)),
    );
    jumpTo(0);
    const entries = historyMenuEntries();
    expect(entries.map(({ id }) => id)).toEqual([
      ...Array.from({ length: 19 }, (_: undefined, index: number) => String(24 - index)),
      "0",
    ]);
    expect(entries).toHaveLength(20);
    expect(entries.every((entry) => Object.keys(entry).sort().join(",") === "id,title")).toBe(true);
    jumpTo(5);
    expect(historyMenuEntries().map(({ id }) => id)).toEqual(
      Array.from({ length: 20 }, (_: undefined, index: number) => String(24 - index)),
    );
  });

  test("history titles resolve live metadata, not visit-time snapshots", () => {
    const id = createSession(1);
    openSession(id);
    navigate({ kind: "route", route: "memory" });
    setSessionTitleIfPlaceholder(id, "earned");
    expect(historyMenuEntries()).toEqual([
      { id: "1", title: "Memory" },
      { id: "0", title: "earned" },
    ]);
  });
});
