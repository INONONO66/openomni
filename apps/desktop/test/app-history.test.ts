import { beforeEach, expect, test } from "bun:test";
import { jumpFrom } from "../src/renderer/shell/history";
import {
  activateTab,
  activeTab,
  consoleStore,
  INITIAL_CLIENT_STATE,
  navigate,
  openTab,
} from "../src/renderer/state/store";

beforeEach(() => consoleStore.setState(() => INITIAL_CLIENT_STATE));

test("captured history jumps reject a changed active tab and changed history, but accept live cursors", () => {
  openTab({ kind: "route", route: "sessions" });
  navigate({ kind: "route", route: "memory" });
  const captured = activeTab(consoleStore.state);
  if (captured === null) throw new Error("Missing tab");
  const onJump = (cursor: string) => jumpFrom(captured, cursor);
  openTab({ kind: "route", route: "inbox" });
  const other = consoleStore.state;
  onJump("0");
  expect(consoleStore.state).toBe(other);
  activateTab(captured.id);
  onJump("0");
  expect(activeTab(consoleStore.state)?.history.cursor).toBe(0);
  const changed = consoleStore.state;
  onJump("1");
  expect(consoleStore.state).toBe(changed);
  jumpFrom(activeTab(consoleStore.state), "1");
  expect(activeTab(consoleStore.state)?.history.cursor).toBe(1);
});

test("empty and invalid cursor callbacks leave the store unchanged", () => {
  const empty = consoleStore.state;
  jumpFrom(null, "0");
  expect(consoleStore.state).toBe(empty);
  openTab({ kind: "route", route: "sessions" });
  const before = consoleStore.state;
  jumpFrom(activeTab(before), "not-a-cursor");
  expect(consoleStore.state).toBe(before);
});
