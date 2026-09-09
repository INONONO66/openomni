import { Chat, useChat } from "@ai-sdk/react";
import {
  Console,
  ConsoleContent,
  type ConsoleShell,
  type ConsoleStrip,
  StatusGlyph,
  type WindowPlatform,
} from "@openomni/ui";
import { useStore } from "@tanstack/react-store";
import type { ChatTransport, UIMessage } from "ai";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ShellCommand } from "../preload/api";
import { applyAtBoundary, orderByAttention } from "./attention";
import type { Boundary, Held } from "./attention";
import { uiMessagesToTranscript } from "./chat/adapter";
import type { OpenOmniUIMessage } from "./chat/message";
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
import { readShellPreferences, writeShellPreferences } from "./state/shell-preferences";
import {
  activateTab,
  activePlace,
  activeTab,
  back,
  canGoBack,
  canGoForward,
  closeTab,
  consoleStore,
  forward,
  historyMenuEntries,
  navigate,
  newSessionTab,
  openTab,
  type Route,
  type Session,
  type SessionId,
  setDraft,
  setSessionTitleIfPlaceholder,
  setSidebarFloating,
  setSidebarOpen,
  setSidebarWidth,
  tabTitle,
  toggleProject,
  toggleSidebar,
} from "./state/store";

export function App({ platform, storage }: AppEnvironment) {
  const state = useStore(consoleStore);
  const now = Date.now();
  const { sessions, tabs, collapsedProjectIds, sidebarOpen, sidebarFloating, sidebarWidth } = state;
  const tab = activeTab(state);
  const place = activePlace(state);
  const history = tab?.history;
  const { transport, notice } = useChatEndpoint();
  const search = useRef({ searching: false, invokingTabId: state.activeTabId });
  const focusRecovery = useRef<"panel" | "tab" | null>(null);
  const [held, setHeld] = useState<Held>(() => ({
    shown: idealOrder(sessions, now),
    pendingChanges: 0,
  }));

  useShellLifecycle(storage);
  const transportRef = useRef(transport);
  useLayoutEffect(() => {
    transportRef.current = transport;
  }, [transport]);
  const wire = useMemo<ChatTransport<UIMessage>>(
    () => ({
      sendMessages: (options) => current(transportRef.current).sendMessages(options),
      reconnectToStream: (options) => current(transportRef.current).reconnectToStream(options),
    }),
    [],
  );
  const chats = useRef<Map<SessionId, Chat<OpenOmniUIMessage>>>(new Map());
  useEffect(() => {
    const cache = chats.current;
    return () => {
      for (const chat of cache.values()) void chat.stop();
    };
  }, []);

  const arrive = useCallback((boundary: Boundary | null = "selection") => {
    const searching = search.current.searching;
    setHeld((previous) =>
      applyAtBoundary(
        previous,
        idealOrder(consoleStore.state.sessions, Date.now()),
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
    const bridge = desktopBridge();
    return bridge?.onShellCommand((command: ShellCommand) => {
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
      title: tabTitle(entry, state),
      icon:
        entry.place.kind === "session" ? (
          <StatusGlyph
            {...sessionGlyphProps(phaseForPlace(entry.place, sessions))}
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
  const session =
    place?.kind === "session"
      ? sessions.find((candidate) => candidate.id === place.sessionId)
      : undefined;
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
        chat={chatFor(chats.current, session.id, wire)}
        key={tab?.id}
        notice={notice}
        session={session}
        transport={transport}
      />
    );
  return <Console content={content} shell={shell} sidebar={sidebar} strip={strip} />;
}

function useChatEndpoint() {
  const endpoint = useGatewayEndpoint();
  const selected = useMemo(
    () => (endpoint.data ? selectChatTransport(endpoint.data) : null),
    [endpoint.data],
  );
  const notice = endpoint.isPending
    ? undefined
    : (endpoint.error?.message ??
      (selected === null
        ? "gateway not configured"
        : selected.kind === "misconfigured"
          ? selected.problem
          : undefined));
  return { transport: selected?.transport ?? null, notice };
}

function useShellLifecycle(storage: Storage | null): void {
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

function SessionContent({
  session,
  chat,
  transport,
  notice,
}: {
  readonly session: Session;
  readonly chat: Chat<OpenOmniUIMessage>;
  readonly transport: ChatTransport<UIMessage> | null;
  readonly notice: string | undefined;
}) {
  const draft = useStore(consoleStore, (state) => state.drafts[session.id] ?? "");
  const { messages, sendMessage, status, stop, addToolApprovalResponse, error } = useChat({ chat });
  const { nodes, costs, pending } = useMemo(() => uiMessagesToTranscript(messages), [messages]);
  const sending = status === "submitted" || status === "streaming";
  const send = () => {
    const text = draft.trim();
    if (
      text === "" ||
      transport === null ||
      chat.status === "submitted" ||
      chat.status === "streaming"
    )
      return;
    setSessionTitleIfPlaceholder(session.id, text);
    void sendMessage({ text });
    setDraft(session.id, "");
  };
  const decide = (approved: boolean) => (approvalId: string) => {
    void addToolApprovalResponse({ id: approvalId, approved });
  };
  return (
    <ConsoleContent
      header={
        <h1 className="flex items-center gap-2 px-section py-3 font-semibold text-label">
          <StatusGlyph {...sessionGlyphProps(session.phase)} />
          {session.title}
        </h1>
      }
      emptyLabel="No turns in this session yet."
      transcript={{
        id: session.id,
        nodes,
        costs,
        draft,
        onDraftChange: (value) => setDraft(session.id, value),
        onSubmit: send,
        onStop: () => void stop(),
        sending,
        composerDisabled: transport === null,
        composerHint: error?.message ?? notice,
        composerMeta: `${Object.keys(costs).length} turns`,
        pending,
        onApprove: decide(true),
        onDeny: decide(false),
      }}
    />
  );
}

function current(transport: ChatTransport<UIMessage> | null): ChatTransport<UIMessage> {
  if (transport === null) throw new Error("gateway not configured");
  return transport;
}

function chatFor(
  chats: Map<SessionId, Chat<OpenOmniUIMessage>>,
  sessionId: SessionId,
  transport: ChatTransport<UIMessage>,
): Chat<OpenOmniUIMessage> {
  const existing = chats.get(sessionId);
  if (existing !== undefined) return existing;
  const created = new Chat<OpenOmniUIMessage>({
    id: sessionId,
    messages: [],
    transport,
    generateId,
  });
  chats.set(sessionId, created);
  return created;
}

let nextId = 0;
const generateId = () => {
  nextId += 1;
  return `m${nextId}`;
};

function phaseForPlace(place: import("./state/store").Place, sessions: readonly Session[]) {
  return place.kind === "session"
    ? (sessions.find((s) => s.id === place.sessionId)?.phase ?? "idle")
    : "idle";
}

function idealOrder(sessions: readonly Session[], now: number) {
  return orderByAttention(sessions, now);
}
