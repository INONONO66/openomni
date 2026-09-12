import { Chat, useChat } from "@ai-sdk/react";
import { ConsoleContent, StatusGlyph } from "@openomni/ui";
import { useStore } from "@tanstack/react-store";
import type { ChatTransport, UIMessage } from "ai";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { sessionGlyphProps } from "../shell/session-glyph";
import {
  consoleStore,
  type Session,
  type SessionId,
  setDraft,
  setSessionTitleIfPlaceholder,
} from "../state/store";
import { uiMessagesToTranscript } from "./adapter";
import type { OpenOmniUIMessage } from "./message";

/** Called by App, not the keyed panel: closing a view must not stop its Chat. */
export function useSessionChats(transport: ChatTransport<UIMessage> | null) {
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
  return (sessionId: SessionId): Chat<OpenOmniUIMessage> => {
    const existing = chats.current.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Chat<OpenOmniUIMessage>({
      id: sessionId,
      messages: [],
      transport: wire,
      generateId,
    });
    chats.current.set(sessionId, created);
    return created;
  };
}

export function SessionContent({
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

let nextId = 0;
const generateId = () => {
  nextId += 1;
  return `m${nextId}`;
};
