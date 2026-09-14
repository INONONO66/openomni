import { expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage } from "ai";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { OpenOmniUIMessage } from "../src/renderer/chat/message";
import { SessionContent } from "../src/renderer/chat/session-content";
import { installGlobals } from "./helpers";
import { makeSession } from "./helpers/session";

/** A decision never sends a message on its own, so any wire use is a failure. */
const idle: ChatTransport<UIMessage> = {
  sendMessages: () => Promise.reject(new Error("no message may be sent by a decision")),
  reconnectToStream: () => Promise.reject(new Error("no stream may be resumed by a decision")),
};

const blocked = (): OpenOmniUIMessage => ({
  id: "answer",
  role: "assistant",
  parts: [
    {
      type: "tool-bash",
      toolCallId: "call-7",
      state: "approval-requested",
      input: { command: "rm -rf dist" },
      approval: { id: "approval-7" },
    },
  ],
});

test.each([
  ["Approve", true],
  ["Deny", false],
])("%s in the tray answers the Chat's blocked tool with that decision", async (control, approved) => {
  const window = new Window({ url: "http://localhost" });
  const restoreGlobals = installGlobals({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const chat = new Chat<OpenOmniUIMessage>({
    id: "session",
    messages: [blocked()],
    transport: idle,
  });
  try {
    await act(() =>
      root.render(
        <SessionContent chat={chat} notice={undefined} session={makeSession()} transport={null} />,
      ),
    );
    expect(host.querySelector('[data-tool-row="approval-7"]')).not.toBeNull();
    const button = host.querySelector<HTMLElement>(`[data-ui="ApprovalTray.${control}"]`);
    expect(button).not.toBeNull();
    await act(() => button?.click());
    expect(chat.lastMessage?.parts).toEqual([
      {
        type: "tool-bash",
        toolCallId: "call-7",
        state: "approval-responded",
        input: { command: "rm -rf dist" },
        approval: { id: "approval-7", approved },
      },
    ]);
    expect(host.querySelector('[data-ui="ApprovalTray"]')).toBeNull();
    expect(host.querySelector('[data-tool-row="call-7"]')).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreGlobals();
    await window.happyDOM.close();
  }
});
