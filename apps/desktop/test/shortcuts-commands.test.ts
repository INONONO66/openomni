import { beforeEach, expect, test } from "bun:test";
import { dispatchShellCommand } from "../src/renderer/shell/commands";
import {
  activeTab,
  activateTab,
  consoleStore,
  INITIAL_CLIENT_STATE,
  navigate,
} from "../src/renderer/state/store";

beforeEach(() => consoleStore.setState(() => INITIAL_CLIENT_STATE));

function currentTab() {
  const tab = activeTab(consoleStore.state);
  if (!tab) throw new Error("Expected an active tab");
  return tab;
}

test("new, close, reopen and empty close dispatch to the real store", () => {
  dispatchShellCommand("close-tab");
  expect(consoleStore.state.tabs).toEqual([]);
  dispatchShellCommand("new-tab");
  const tab = currentTab();
  expect(tab.place.kind).toBe("session");
  expect(consoleStore.state.sessions).toHaveLength(1);
  dispatchShellCommand("close-tab");
  expect(consoleStore.state.tabs).toEqual([]);
  expect(consoleStore.state.activeTabId).toBeNull();
  expect(consoleStore.state.sessions).toHaveLength(1);
  dispatchShellCommand("reopen-tab");
  expect(currentTab()).toEqual(tab);
});

test("every ordinal command and positional cycle selects the real tab", () => {
  for (let index = 0; index < 11; index++) dispatchShellCommand("new-tab");
  for (const [index, command] of (
    [
      "select-tab-1",
      "select-tab-2",
      "select-tab-3",
      "select-tab-4",
      "select-tab-5",
      "select-tab-6",
      "select-tab-7",
      "select-tab-8",
      "select-tab-9",
    ] as const
  ).entries()) {
    dispatchShellCommand(command);
    expect(consoleStore.state.activeTabId).toBe(
      consoleStore.state.tabs[index === 8 ? 10 : index]?.id ?? null,
    );
  }
  dispatchShellCommand("next-tab");
  expect(consoleStore.state.tabs[0]).toBe(currentTab());
  dispatchShellCommand("previous-tab");
  expect(consoleStore.state.tabs[10]).toBe(currentTab());
});

test("history dispatch stays in its tab when another tab currently shows its destination", () => {
  dispatchShellCommand("new-tab");
  const first = currentTab();
  dispatchShellCommand("new-tab");
  const second = currentTab();
  navigate({ kind: "route", route: "inbox" });
  activateTab(first.id);
  navigate(second.place);
  navigate({ kind: "route", route: "memory" });
  activateTab(second.id);
  navigate(second.place);
  const other = currentTab();
  activateTab(first.id);
  dispatchShellCommand("back");
  expect(currentTab().id).toBe(first.id);
  expect(currentTab().place).toEqual(second.place);
  expect(currentTab().history.cursor).toBe(1);
  expect(consoleStore.state.tabs.find((tab) => tab.id === other.id)).toBe(other);
  dispatchShellCommand("forward");
  expect(currentTab().id).toBe(first.id);
  expect(currentTab().place).toEqual({ kind: "route", route: "memory" });
  expect(currentTab().history.cursor).toBe(2);
  expect(consoleStore.state.tabs.find((tab) => tab.id === other.id)).toBe(other);
});
