import {
  Console,
  ConsoleContent,
  type ConsoleShell,
  type ConsoleStrip,
  StatusGlyph,
  type WindowPlatform,
} from "@openomni/ui";
import { useStore } from "@tanstack/react-store";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ShellCommand } from "../preload/api";
import { applyAtBoundary, orderByAttention } from "./attention";
import type { Boundary, Held } from "./attention";
import { SessionContent, useSessionChats } from "./chat/session-content";
import { selectChatTransport } from "./chat/select-transport";
import { dispatchShellCommand } from "./shell/commands";
import { jumpFrom } from "./shell/history";
import { placeIcon } from "./shell/place-icon";
import { SessionList } from "./shell/session-list";
import { sessionGlyphProps } from "./shell/session-glyph";
import { SessionTree } from "./shell/session-tree";
import { shellShortcut } from "./shell/shortcuts";
import { desktopBridge } from "./state/desktop-bridge";
import { useGatewayEndpoint } from "./state/queries";
import { historyMenuEntries, sessionIndex, placeTitle } from "./state/selectors";
import { readShellPreferences, writeShellPreferences } from "./state/shell-preferences";
import {
  activateTab,
  activeTab,
  back,
  canGoBack,
  canGoForward,
  closeTab,
  consoleStore,
  forward,
  navigate,
  newSessionTab,
  openTab,
  type Route,
  type SessionId,
  setSidebarFloating,
  setSidebarOpen,
  setSidebarWidth,
  toggleProject,
  toggleSidebar,
} from "./state/store";

export function App({ platform, storage }: AppEnvironment) {
  const state = useStore(consoleStore);
  const now = Date.now();
  const { sessions, tabs, collapsedProjectIds, sidebarOpen, sidebarFloating, sidebarWidth } = state;
  const tab = activeTab(state);
  const place = tab?.place ?? null;
  const byId = sessionIndex(sessions);
  const history = tab?.history;
  const endpoint = useGatewayEndpoint();
  const search = useRef({ searching: false, invokingTabId: state.activeTabId });
  const focusRecovery = useRef<"panel" | "tab" | null>(null);
  const [held, setHeld] = useState<Held>(() => ({
    shown: orderByAttention(sessions, now),
    pendingChanges: 0,
  }));

  useLayoutEffect(() => {
    if (storage === null) return;
    const remembered = readShellPreferences(storage);
    setSidebarOpen(remembered.open);
    setSidebarWidth(remembered.width);
    const subscription = consoleStore.subscribe(() => {
      writeShellPreferences(storage, {
        open: consoleStore.state.sidebarOpen,
        width: consoleStore.state.sidebarWidth,
      });
    });
    return subscription.unsubscribe;
  }, [storage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shellShortcut(event, isEditing(event.target)) === null) return;
      toggleSidebar();
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const selected = useMemo(
    () => (endpoint.data ? selectChatTransport(endpoint.data) : null),
    [endpoint.data],
  );
  const transport = selected?.transport ?? null;
  const notice = endpoint.isPending
    ? undefined
    : (endpoint.error?.message ??
      (selected === null
        ? "gateway not configured"
        : selected.kind === "misconfigured"
          ? selected.problem
          : undefined));
  const chatFor = useSessionChats(transport);

  const arrive = useCallback((boundary: Boundary | null = "selection") => {
    const searching = search.current.searching;
    setHeld((previous) =>
      applyAtBoundary(
        previous,
        orderByAttention(consoleStore.state.sessions, Date.now()),
        searching ? null : boundary,
      ),
    );
    if (!searching) setSidebarFloating(false);
  }, []);

  const captureCloseFocus = useCallback((id: string) => {
    const focused = document.activeElement;
    const panel = document.getElementById(`tab-panel-${id}`);
    const control = document.getElementById(`tab-${id}`)?.parentElement;
    focusRecovery.current = panel?.contains(focused)
      ? "panel"
      : control?.contains(focused)
        ? "tab"
        : null;
  }, []);

  useLayoutEffect(() => {
    const scope = focusRecovery.current;
    if (scope === null) return;
    focusRecovery.current = null;
    const id = tabs.find((entry) => entry.id === state.activeTabId)?.id ?? null;
    const editor =
      id === null || scope !== "panel"
        ? null
        : document
            .getElementById(`tab-panel-${id}`)
            ?.querySelector<HTMLElement>('textarea:not(:disabled), [contenteditable="true"]');
    const successor = id === null ? null : document.getElementById(`tab-${id}`);
    (
      editor ??
      successor ??
      document.querySelector<HTMLElement>('[data-ui="TabStrip.Create"]')
    )?.focus();
  }, [state.activeTabId, tabs]);

  useEffect(() => {
    return desktopBridge()?.onShellCommand((command: ShellCommand) => {
      const before = consoleStore.state;
      if (command === "close-tab" && before.activeTabId !== null)
        captureCloseFocus(before.activeTabId);
      dispatchShellCommand(command);
      if (consoleStore.state !== before) arrive();
    });
  }, [arrive, captureCloseFocus]);

  const onSearchingChange = useCallback((searching: boolean) => {
    if (searching && !search.current.searching) {
      search.current.invokingTabId = consoleStore.state.activeTabId;
    }
    search.current.searching = searching;
    setSidebarFloating(searching && !consoleStore.state.sidebarOpen);
  }, []);

  // Clicking moves the current tab; only ⌘/Ctrl-click (or `+`) opens a new one.
  const select = (id: SessionId, boundary: Boundary | null = "selection", newTab = false) => {
    const place = { kind: "session", sessionId: id } as const;
    if (newTab) openTab(place);
    else
      navigate(
        place,
        boundary === null ? search.current.invokingTabId : consoleStore.state.activeTabId,
      );
    arrive(boundary);
  };
  const travel = (action: () => void) => {
    const before = consoleStore.state;
    action();
    if (consoleStore.state !== before) arrive();
  };
  const shell: ConsoleShell = {
    sidebarOpen,
    sidebarFloating,
    sidebarWidth,
    onToggleSidebar: toggleSidebar,
    onSidebarFloatingChange: (floating) => {
      if (floating || !search.current.searching) setSidebarFloating(floating);
    },
    onSidebarWidthCommit: setSidebarWidth,
  };
  const strip: ConsoleStrip = {
    tabs: tabs.map((entry) => ({
      id: entry.id,
      title: placeTitle(entry.place, state),
      icon:
        entry.place.kind === "session" ? (
          <StatusGlyph
            {...sessionGlyphProps(byId.get(entry.place.sessionId)?.phase ?? "idle")}
            size="compact"
          />
        ) : (
          placeIcon(entry.place)
        ),
      active: entry.id === state.activeTabId,
    })),
    onActivate: (id) => {
      activateTab(id);
      arrive();
    },
    onClose: (id) => {
      captureCloseFocus(id);
      travel(() => closeTab(id));
    },
    createLabel: "New session",
    onCreate: () => travel(newSessionTab),
    platform,
    history: {
      entries: historyMenuEntries(state),
      currentId: history === undefined ? null : String(history.cursor),
      now,
      canBack: history !== undefined && canGoBack(history),
      canForward: history !== undefined && canGoForward(history),
      onBack: () => travel(back),
      onForward: () => travel(forward),
      onJump: (cursor) => travel(() => jumpFrom(tab, cursor)),
    },
  };
  const sidebar = (
    <SessionTree
      collapsedProjectIds={collapsedProjectIds}
      onNavigate={(route, newTab) => {
        const place = { kind: "route", route } as const;
        if (newTab) openTab(place);
        else navigate(place);
        arrive();
      }}
      onSearchingChange={onSearchingChange}
      onSelect={select}
      onToggleProject={toggleProject}
      ordered={held.shown}
      pendingChanges={held.pendingChanges}
      route={place?.kind === "route" ? place.route : null}
      selectedId={place?.kind === "session" ? place.sessionId : null}
      sessions={sessions}
      now={now}
    />
  );
  const session = place?.kind === "session" ? byId.get(place.sessionId) : undefined;
  const content =
    session === undefined ? (
      <ConsoleContent
        emptyLabel={
          place?.kind === "route" && place.route !== "sessions"
            ? ROUTE_EMPTY[place.route]
            : "Select or create a session"
        }
        key={tab?.id ?? "empty"}
      >
        {place?.kind === "route" && place.route === "sessions" ? (
          <SessionList now={now} onSelect={select} ordered={held.shown} sessions={sessions} />
        ) : undefined}
      </ConsoleContent>
    ) : (
      <SessionContent
        chat={chatFor(session.id)}
        key={tab?.id}
        notice={notice}
        session={session}
        transport={transport}
      />
    );
  return <Console content={content} shell={shell} sidebar={sidebar} strip={strip} />;
}

export interface AppEnvironment {
  readonly platform: WindowPlatform;
  readonly storage: Storage | null;
}

function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

const ROUTE_EMPTY = {
  inbox: "Nothing in the inbox.",
  automations: "No automations yet.",
  memory: "Nothing remembered yet.",
} as const satisfies Record<Exclude<Route, "sessions">, string>;
