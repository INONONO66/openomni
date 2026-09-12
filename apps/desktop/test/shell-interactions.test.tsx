import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { Timeline } from "@openomni/ui";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/renderer/app";
import { uiMessagesToTranscript } from "../src/renderer/chat/adapter";
import type { OpenOmniUIMessage } from "../src/renderer/chat/message";
import { StateProvider } from "../src/renderer/state/provider";
import { queryKeys } from "../src/renderer/state/queries";
import { SIDEBAR_OPEN_KEY, SIDEBAR_WIDTH_KEY } from "../src/renderer/state/shell-preferences";
import { activePlace, consoleStore, INITIAL_CLIENT_STATE } from "../src/renderer/state/store";
import { installGlobals } from "./helpers";

test("mounted shell restores preferences, navigates, creates and searches sessions", async () => {
  const window = new Window({ url: "http://localhost" });
  const replacements = {
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
  };
  const restoreGlobals = installGlobals(replacements);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  client.setQueryData(queryKeys.gatewayEndpoint, null);
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
  window.localStorage.setItem(SIDEBAR_OPEN_KEY, "false");
  window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "288");
  const key = (value: string) =>
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  const click = async (selector: string) => {
    const button = host.querySelector<HTMLElement>(selector);
    expect(button).not.toBeNull();
    await act(() => button?.click());
  };
  try {
    await act(() =>
      root.render(
        <StateProvider client={client}>
          <App platform="darwin" storage={window.localStorage} />
        </StateProvider>,
      ),
    );
    expect(consoleStore.state.sidebarWidth).toBe(288);
    expect(host.querySelector('[data-ui="Sidebar"]')?.getAttribute("data-sidebar-state")).toBe(
      "collapsed",
    );
    await act(() => key("["));
    expect(consoleStore.state.sidebarOpen).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_OPEN_KEY)).toBe("true");
    await click('[data-ui="Sidebar.Nav"] button:nth-child(2)');
    expect(activePlace(consoleStore.state)).toEqual({ kind: "route", route: "inbox" });
    // A plain click moves the current tab (the empty column materializes exactly one); it never grows the strip.
    const tabsBefore = consoleStore.state.tabs.length;
    expect(tabsBefore).toBe(1);
    await click('[data-ui="Sidebar.Nav"] button:nth-child(4)');
    expect(activePlace(consoleStore.state)).toEqual({ kind: "route", route: "memory" });
    expect(consoleStore.state.tabs.length).toBe(tabsBefore);
    await act(() =>
      window.document
        .querySelector('[data-ui="Sidebar.Nav"] button:nth-child(3)')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })),
    );
    expect(consoleStore.state.tabs.length).toBe(tabsBefore + 1);
    expect(activePlace(consoleStore.state)).toEqual({ kind: "route", route: "automations" });
    await act(() => key("["));
    expect(consoleStore.state.sidebarOpen).toBe(false);
    await act(() => key("["));
    expect(consoleStore.state.sidebarOpen).toBe(true);
    await click('button[aria-label="New session"]');
    expect(consoleStore.state.sessions).toHaveLength(1);
    const selected = consoleStore.state.sessions[0]?.id ?? "";
    expect(selected).not.toBe("");
    expect(activePlace(consoleStore.state)).toEqual({ kind: "session", sessionId: selected });
    expect(host.querySelector("textarea")?.disabled).toBe(true);
    await click('button[aria-label="New session"]');
    expect(consoleStore.state.sessions).toHaveLength(2);
    await click(`#session-row-${selected}`);
    expect(activePlace(consoleStore.state)).toEqual({ kind: "session", sessionId: selected });
    await click('[data-ui="SectionHeader.Toggle"]');
    expect(host.querySelector('[role="combobox"]')).not.toBeNull();
    await act(() =>
      window.document
        .querySelector("input")
        ?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(host.querySelector('[role="combobox"]')).toBeNull();
    await act(() => key("x"));
    expect(consoleStore.state.sessions).toHaveLength(2);

    const messages: OpenOmniUIMessage[] = [
      {
        id: "epoch",
        role: "assistant",
        parts: [{ type: "data-epoch", data: { label: "checkpoint" } }],
      },
      {
        id: "answer",
        role: "assistant",
        metadata: { startedAt: 0, elapsedMs: 2000 },
        parts: [
          {
            type: "tool-bash",
            toolCallId: "running",
            state: "input-available",
            input: { command: "build" },
          },
          {
            type: "tool-bash",
            toolCallId: "waiting",
            state: "approval-requested",
            input: { command: "build" },
            approval: { id: "approval" },
          },
          {
            type: "tool-bash",
            toolCallId: "failed",
            state: "output-error",
            input: { command: "build" },
            errorText: "fixture",
          },
          {
            type: "tool-bash",
            toolCallId: "denied",
            state: "output-denied",
            input: { command: "build" },
            approval: { id: "denied-approval", approved: false },
          },
          {
            type: "text",
            text: "## Heading\n\nParagraph\n\n- one\n- two\n\n```ts\nconst n = 1;\n```",
          },
        ],
      },
    ];
    const transcript = uiMessagesToTranscript(messages);
    await act(() =>
      root.render(
        <Timeline
          emptyLabel="empty"
          sessionId="fixture"
          nodes={transcript.nodes}
          costs={transcript.costs}
        />,
      ),
    );
    expect(host.querySelector("[data-epoch-rule]")).not.toBeNull();
    expect(host.querySelector('[data-tool-row="running"]')).not.toBeNull();
    expect(host.querySelector('[data-tool-row="approval"]')).not.toBeNull();
    expect(host.querySelector('[data-tool-row="denied"]')).not.toBeNull();
    const output = host.querySelector<HTMLElement>('[data-tool-row="failed"] button');
    expect(output?.getAttribute("aria-expanded")).toBe("false");
    await act(() => output?.click());
    expect(output?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-tool-row="failed"] pre')).not.toBeNull();
    await act(() => output?.click());
    expect(host.querySelector('[data-tool-row="failed"] pre')).toBeNull();
    expect(host.querySelector("[data-turn-time]")).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    client.clear();
    consoleStore.setState(() => INITIAL_CLIENT_STATE);
    host.remove();
    restoreGlobals();
    await window.happyDOM.close();
  }
});
