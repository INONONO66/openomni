import { activeTab, consoleStore, jumpTo, type Tab } from "../state/store";

export function jumpFrom(tab: Tab | null, cursor: string): void {
  const current = activeTab(consoleStore.state);
  if (current?.id !== tab?.id || current?.history !== tab?.history) return;
  jumpTo(Number(cursor));
}
