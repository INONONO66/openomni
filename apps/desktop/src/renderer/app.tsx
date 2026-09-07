import { Chat, useChat } from "@ai-sdk/react";
import { Console } from "@openomni/ui";
import { useStore } from "@tanstack/react-store";
import type { ChatTransport, UIMessage } from "ai";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyAtBoundary, orderByAttention } from "./attention";
import type { Boundary, Held } from "./attention";
import { uiMessagesToTranscript } from "./chat/adapter";
import type { OpenOmniUIMessage } from "./chat/message";
import { selectChatTransport } from "./chat/select-transport";
import { SessionTree } from "./shell/session-tree";
import { useGatewayEndpoint } from "./state/queries";
import {
  consoleStore,
  createSession,
  type Session,
  type SessionId,
  selectSession,
  setDraft,
  toggleProject,
} from "./state/store";

/**
 * The shell: [session navigator | transcript], wired to the store and the wire.
 *
 * This file's job is what the design system must not know: which session is
 * selected, how the list is ranked, where the gateway is, and what the
 * product's words are. It composes `Console` from `@openomni/ui`; it does not
 * draw one.
 *
 * Client state — the sessions this window created, the selection, the drafts,
 * which groups are closed — is read from `state/store.ts` through selectors,
 * so a keystroke in a draft re-renders the composer and not the tree. Server
 * state — today only the gateway endpoint — comes through `state/queries.ts`,
 * and the app renders IMMEDIATELY rather than awaiting it: the window is
 * useful before the endpoint answers, and the composer simply stays disabled
 * until it does.
 *
 * Ordering runs through `attention` and is applied at a focus boundary only —
 * a selection change, or creating a session, which selects it. Between
 * boundaries the previous order is held, so the list never reflows under the
 * cursor. A selection made FROM the search field is deliberately not a
 * boundary: the operator is still inside the control, narrowing.
 */
export function App() {
  const sessions = useStore(consoleStore, (state) => state.sessions);
  const selectedId = useStore(consoleStore, (state) => state.selectedSessionId);
  const collapsedProjectIds = useStore(consoleStore, (state) => state.collapsedProjectIds);
  const endpoint = useGatewayEndpoint();

  const [held, setHeld] = useState<Held>(() => ({
    shown: idealOrder(sessions),
    pendingChanges: 0,
  }));

  // The wire, derived from the endpoint query. `null` while the query is in
  // flight, when this build has no gateway, and when the configured token
  // cannot be offered — three states the composer reports in one line rather
  // than talking to anything fabricated.
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

  // Adopt the ideal order for the store's CURRENT sessions. Read off the store
  // rather than the selector's value so a session created in this same handler
  // is already in the order that boundary adopts.
  const adopt = (boundary: Boundary | null) =>
    setHeld((previous) =>
      applyAtBoundary(previous, idealOrder(consoleStore.state.sessions), boundary),
    );

  // Selection change IS the breakpoint: the Owner has just finished deciding
  // what to look at, so a new order costs them nothing — UNLESS the decision
  // was made from inside the search field, where they have not finished yet.
  const select = (id: SessionId, boundary: Boundary | null = "selection") => {
    selectSession(id);
    adopt(boundary);
  };

  const create = () => {
    createSession();
    adopt("selection");
  };

  const session = sessions.find((candidate) => candidate.id === selectedId);
  const sidebar = (
    <SessionTree
      collapsedProjectIds={collapsedProjectIds}
      onCreate={create}
      onSelect={select}
      onToggleProject={toggleProject}
      ordered={held.shown}
      pendingChanges={held.pendingChanges}
      selectedId={selectedId}
      sessions={sessions}
    />
  );

  return (
    // The window's own height. `Console` fills whatever box it is given.
    <div className="h-screen min-h-0">
      {session === undefined ? (
        <Console emptyLabel="Select or create a session" sidebar={sidebar} />
      ) : (
        <SessionConsole notice={notice} session={session} sidebar={sidebar} transport={transport} />
      )}
    </div>
  );
}

/**
 * The main column for ONE open session, and the only place `useChat` runs.
 *
 * It is a component of its own so the hook has a session to run over: with
 * nothing selected there is no chat, and a hook cannot be skipped, so the split
 * is what lets the empty column be honestly empty instead of a chat for a
 * session that does not exist.
 */
function SessionConsole({
  session,
  sidebar,
  transport,
  notice,
}: {
  readonly session: Session;
  readonly sidebar: ReactNode;
  readonly transport: ChatTransport<UIMessage> | null;
  /** Why the composer is disabled, when it is. */
  readonly notice: string | undefined;
}) {
  const draft = useStore(consoleStore, (state) => state.drafts[session.id] ?? "");

  // One `Chat` per session, kept in a ref so a re-render never rebuilds one and
  // drops a stream mid-turn. A session the Owner has never opened has no chat
  // at all. The chat sends through `wire`, which reads the CURRENT transport at
  // send time — `Chat` takes its transport at construction, and the endpoint
  // query may not have answered when the first chat is built.
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
  const chat = chatFor(chats.current, session.id, wire);

  const { messages, sendMessage, status, stop, addToolApprovalResponse } = useChat({ chat });

  const { nodes, costs, pending } = useMemo(() => uiMessagesToTranscript(messages), [messages]);
  // `submitted` is the window between the send and the first chunk; without it
  // the composer unlocks for exactly as long as the request takes to reach the
  // transport, which is where a double-send comes from.
  const sending = status === "submitted" || status === "streaming";

  const send = () => {
    const text = draft.trim();
    if (text === "" || transport === null) return;
    void sendMessage({ text });
    setDraft(session.id, "");
  };

  // The tray hands back the APPROVAL's id, because that is what the adapter put
  // on the row and the only identifier the SDK will accept a decision under.
  const decide = (approved: boolean) => (approvalId: string) => {
    void addToolApprovalResponse({ id: approvalId, approved });
  };

  return (
    <Console
      emptyLabel="No turns in this session yet."
      session={{
        id: session.id,
        title: session.title,
        nodes,
        costs,
        draft,
        onDraftChange: (value) => setDraft(session.id, value),
        onSubmit: send,
        // Per SESSION, because `stop` belongs to the chat the hook is currently
        // subscribed to: it aborts the turn the Owner is watching, and switching
        // sessions mid-stream leaves the other one running, which is what one
        // chat per session is for.
        onStop: () => void stop(),
        sending,
        composerDisabled: transport === null,
        composerHint: notice,
        composerMeta: `${Object.keys(costs).length} turns`,
        pending,
        onApprove: decide(true),
        onDeny: decide(false),
      }}
      sidebar={sidebar}
    />
  );
}

/** The transport to send on right now, or the reason there is none. */
function current(transport: ChatTransport<UIMessage> | null): ChatTransport<UIMessage> {
  if (transport === null) throw new Error("gateway not configured");
  return transport;
}

/**
 * The chat for a session, created on first sight and never again.
 *
 * It starts EMPTY, always. There is no history on the wire yet, and seeding a
 * session with anything else would open the transcript on a conversation
 * nobody had — the one failure a real connection must not introduce.
 */
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

/**
 * Message ids, from a counter rather than the SDK's random default.
 *
 * The renderer's tests render the shell to static markup and assert on it, and
 * an id that changes per run turns any such assertion into a coin flip. The
 * counter is per window and never leaves it — nothing downstream treats a
 * message id as globally unique.
 */
let nextId = 0;
const generateId = () => {
  nextId += 1;
  return `m${nextId}`;
};

/** The engine's input: the facts a store session actually carries. */
function idealOrder(sessions: readonly Session[]) {
  return orderByAttention(
    sessions.map((session) => ({
      id: session.id,
      projectId: session.projectId,
      createdAt: session.createdAt,
    })),
  );
}
