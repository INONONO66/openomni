import type { ShellCommand } from "../../preload/api";
import {
  activateTabAt,
  back,
  closeTab,
  consoleStore,
  cycleTab,
  forward,
  newSessionTab,
  reopenClosedTab,
} from "../state/store";

export function dispatchShellCommand(command: ShellCommand): void {
  switch (command) {
    case "new-tab":
      newSessionTab();
      return;
    case "close-tab": {
      const { activeTabId } = consoleStore.state;
      if (activeTabId !== null) closeTab(activeTabId);
      return;
    }
    case "reopen-tab":
      reopenClosedTab();
      return;
    case "next-tab":
      cycleTab(1);
      return;
    case "previous-tab":
      cycleTab(-1);
      return;
    case "back":
      back();
      return;
    case "forward":
      forward();
      return;
    case "select-tab-1":
    case "select-tab-2":
    case "select-tab-3":
    case "select-tab-4":
    case "select-tab-5":
    case "select-tab-6":
    case "select-tab-7":
    case "select-tab-8":
    case "select-tab-9":
      activateTabAt(Number(command.slice(-1)));
      return;
    default: {
      const unhandled: never = command;
      throw new Error(`Unhandled shell command: ${unhandled}`);
    }
  }
}
