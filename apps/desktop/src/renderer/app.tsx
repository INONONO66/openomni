import { Chat, useChat } from "@ai-sdk/react";
import { Console } from "@openomni/ui";
import type { ChatTransport, UIMessage } from "ai";
import { useMemo, useRef, useState } from "react";
import { applyAtBoundary, orderByAttention } from "./attention";
import type { Boundary, Held, ProjectSessionFacts, Signals } from "./attention";
import { uiMessagesToTranscript } from "./chat/adapter";
import type { OpenOmniUIMessage } from "./chat/message";
import { createMockChatTransport } from "./chat/mock-transport";
import type { SessionId } from "./mock/console";
import {
  lastReadAt,
  now,
  pins,
  projects,
  selectedSessionId,
  sessions,
  snoozes,
} from "./mock/console";
import { timelines } from "./mock/timelines";
import { SessionTree } from "./shell/session-tree";

/**
 * Static shell over the mock data: [session navigator | transcript].
 *
 * The right-hand detail column is gone. A third column that is empty by design
 * spends a fifth of the window on nothing, and the surface this system is
 * building keeps content centered with the sides deliberately clear.
 *
 * The composer and the approval tray are wired to a real `Chat` from the AI
 * SDK, one per session, over whichever transport this window was handed.
 * Sending streams a reply and approving posts a tool-approval response — the
 * same calls either way, which is what makes the gateway a substitution rather
 * than a second code path. Which wire that is, is decided in
 * `chat/select-transport.ts` and passed IN: a component that reached for
 * `window.desktop` itself could not be rendered by the showcase, by the
 * screenshot script, or by a test.
 *
 * Ordering runs through `attention` and is applied at a focus boundary only —
 * here, a selection change. Between boundaries the previous order is held, so
 * the list never reflows under the cursor.
 *
 * A selection made FROM the search field is deliberately not a boundary. The
 * operator is still inside the control, narrowing; reordering the rows they are
 * arrowing through is the exact reflow the rule exists to prevent, and it is
 * worse under a query than at rest because the result set moves too.
 *
 * The screen itself is `Console` from `@openomni/ui`, rendered here with live
 * data and in the showcase with a fixture — one component, so the two cannot
 * drift. This file's job is what the design system must not know: which session
 * is selected, how the list is ranked, and what the product's words are. It
 * composes the shell; it does not draw one.
 */
export function App({ transport = MOCK_TRANSPORT }: { readonly transport?: ChatTransport<UIMessage> }) {
  const [selected, setSelected] = useState(selectedSessionId);
  const [held, setHeld] = useState<Held>(() => ({
    shown: idealOrder(selectedSessionId),
    pendingChanges: 0,
  }));
  // The draft is per session: switching away and back must not hand the Owner
  // a half-written message addressed to a different agent.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  // One `Chat` per session, kept in a ref so a re-render never rebuilds one and
  // drops a stream mid-turn. A session the Owner has never opened has no chat
  // at all: constructing seven of them up front would attach seven transports
  // to keep six idle conversations warm.
  const chats = useRef<Map<SessionId, Chat<OpenOmniUIMessage>>>(new Map());
  const chat = chatFor(chats.current, selected, transport);

  // Unconditional, on every render, with the selected chat chosen ABOVE it —
  // `useChat` is a hook, and selecting inside it would make the hook order
  // depend on which session is open.
  const { messages, sendMessage, status, stop, addToolApprovalResponse } = useChat({ chat });

  const session = sessions.find((candidate) => candidate.id === selected);
  const { nodes, costs, pending } = useMemo(() => uiMessagesToTranscript(messages), [messages]);
  // `submitted` is the window between the send and the first chunk; without it
  // the composer unlocks for exactly as long as the request takes to reach the
  // transport, which is where a double-send comes from.
  const sending = status === "submitted" || status === "streaming";

  const send = () => {
    const text = drafts[selected]?.trim() ?? "";
    if (text === "") return;
    void sendMessage({ text });
    setDrafts((was) => ({ ...was, [selected]: "" }));
  };

  // The tray hands back the APPROVAL's id, because that is what the adapter put
  // on the row and the only identifier the SDK will accept a decision under.
  const decide = (approved: boolean) => (approvalId: string) => {
    void addToolApprovalResponse({ id: approvalId, approved });
  };

  // Selection change IS the breakpoint: the Owner has just finished deciding
  // what to look at, so a new order costs them nothing — UNLESS the decision
  // was made from inside the search field, where they have not finished yet.
  const select = (id: string, boundary: Boundary | null = "selection") => {
    setSelected(id);
    setHeld((previous) => applyAtBoundary(previous, idealOrder(id), boundary));
  };

  return (
    // The window's own height. `Console` fills whatever box it is given, which
    // is what lets the showcase mount the same component in a bounded pane.
    <div className="h-screen min-h-0">
      <Console
        composerHint={session?.agent ?? "—"}
        composerMeta={`${Object.keys(costs).length} turns`}
        costs={costs}
        detail={session?.agent ?? "—"}
        draft={drafts[selected] ?? ""}
        emptyLabel="No turns in this session yet."
        nodes={nodes}
        onApprove={decide(true)}
        onDeny={decide(false)}
        onDraftChange={(value) => setDrafts((was) => ({ ...was, [selected]: value }))}
        // Per SESSION, because `stop` belongs to the chat the hook is currently
        // subscribed to: it aborts the turn the Owner is watching, and switching
        // sessions mid-stream leaves the other one running, which is what one
        // chat per session is for.
        onStop={() => void stop()}
        onSubmit={send}
        pending={pending}
        sending={sending}
        sessionId={selected}
        sidebar={
          <SessionTree
            onSelect={select}
            ordered={held.shown}
            pendingChanges={held.pendingChanges}
            projects={projects}
            selectedId={selected}
            sessions={sessions}
          />
        }
        title={session?.name ?? "—"}
      />
    </div>
  );
}

/**
 * The chat for a session, created on first sight and never again.
 *
 * The fixture is the chat's INITIAL messages rather than a separate rendering
 * path, so the moment the Owner sends, the streamed reply lands in the same
 * list the fixture is in and the transcript keeps one source. Everything the
 * surface draws is derived from that list.
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
    messages: [...(timelines[sessionId] ?? [])],
    transport,
    generateId,
  });
  chats.set(sessionId, created);
  return created;
}

/**
 * ONE transport for every chat, and the default when nothing hands one in.
 *
 * The gateway holds a single socket for the whole window, so the shape is the
 * same either way: sessions share a connection and are told apart by the chat
 * they belong to. A transport per chat would have made the swap a rewrite
 * instead of a substitution.
 */
// One chunk per paint keeps the mock's in-flight state visible in the real
// renderer instead of collapsing the whole reply into one React render.
const MOCK_TRANSPORT = createMockChatTransport({
  replies: [
    "The mock transport is streaming this reply through the Console so the in-flight assistant answer remains visible before the chat returns to ready.",
  ],
  chunkSize: 4,
  tick: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
});

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

/**
 * The engine's input. `now` is the mock's fixed instant rather than the wall
 * clock, so the shell renders the same ranking on every run — the same property
 * the tests rely on, for the same reason.
 */
function idealOrder(activeSessionId: string) {
  const signals: Signals = {
    now,
    activeSessionId,
    pins,
    snoozes,
    lastReadAt,
    userBusy: false,
  };
  const facts: readonly ProjectSessionFacts[] = sessions.map((session) => ({
    id: session.id,
    projectId: session.projectId,
    state: session.state,
    lastEventAt: session.lastEventAt,
    lastUserTurnAt: session.lastUserTurnAt,
    unreadCount: session.unreadCount,
  }));

  return orderByAttention(
    projects.map((project) => project.id),
    facts,
    signals,
  );
}
