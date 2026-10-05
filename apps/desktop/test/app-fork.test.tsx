import { beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { z } from "zod";
import { App } from "../src/renderer/app";
import { StateProvider } from "../src/renderer/state/provider";
import { queryKeys } from "../src/renderer/state/queries";
import { bindDurableSession } from "../src/renderer/state/session-actions";
import { consoleStore, INITIAL_CLIENT_STATE, newSessionTab } from "../src/renderer/state/store";
import { mountWindow } from "./helpers";
import { upgradeWebSocket } from "./helpers/chat-server";
import { testPlatform } from "./helpers/platform";

beforeEach(() => consoleStore.setState(() => INITIAL_CLIENT_STATE));

const pin = { session: "durable", anchor: "hash-2", parentSeq: 3, parentHead: "head-3", copied: 4 };

/** The gateway double: pages carry a boundary anchor; the fork answers in order. */
function serveFork() {
  let forkCalls = 0;
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: upgradeWebSocket,
    websocket: {
      message(socket: ServerWebSocket<undefined>, raw) {
        const frame = z.record(z.string(), z.json()).parse(JSON.parse(String(raw)));
        if (frame.type === "session_read") {
          socket.send(JSON.stringify({
            type: frame.cursor === undefined ? "session_snapshot" : "session_page",
            sessionId: frame.sessionId, state: "idle", phase: "completed", phaseSince: 100,
            epoch: 1, afterRevision: 0, headRevision: 1, nextRevision: null,
            actions: [{ revision: 1, actionId: "turn-1", kind: "turn", at: 120, forkAnchor: "hash-2" }],
            usage: [], toolWallMs: 0,
          }));
          return;
        }
        if (frame.type !== "session_fork") return;
        forkCalls += 1;
        if (forkCalls === 3) {
          // The dead-gateway leg: close instead of answering, so the client's
          // pending fork waiter is rejected by the socket drain.
          socket.close();
          return;
        }
        socket.send(JSON.stringify(forkCalls === 1
          ? { type: "session_fork_refused", sessionId: frame.sessionId,
              reason: "byte_cap", detail: "copied bytes exceed the cap" }
          : { type: "session_forked", sessionId: "child-1", parentId: frame.sessionId,
              forkedFrom: pin, head: "child-head" }));
      },
    },
  });
}

/**
 * Flush React work until `predicate` holds. Updates born outside `act` (wire
 * frames, query cache writes) queue in the act environment, so each round
 * yields the event loop INSIDE `act` and lets React render what arrived. The
 * loop exits on the exact observable condition, bounded by the cap.
 */
async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("condition never became true");
}

test("the desktop fork control adopts the gateway's child and surfaces typed refusals", async () => {
  const server = serveFork();
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  const client = new QueryClient();
  const localId = newSessionTab();
  bindDurableSession(localId, "durable");
  client.setQueryData(queryKeys.gatewayEndpoint, { url: `ws://127.0.0.1:${server.port}` });
  try {
    await act(() =>
      root.render(
        <StateProvider client={client}>
          <App platform="darwin" storage={null} host={testPlatform} />
        </StateProvider>,
      ),
    );
    // The page's boundary anchor earns the fork control.
    await flushUntil(() => host.querySelector('[data-ui="SessionContent.Fork"]') !== null);
    const button = host.querySelector<HTMLElement>('[data-ui="SessionContent.Fork"]');
    expect(button).not.toBeNull();

    // First answer: the typed refusal reaches the composer as a sentence.
    await act(() => button?.click());
    await flushUntil(() => host.textContent?.includes("fork refused: byte_cap") === true);
    expect(host.textContent).toContain("copied bytes exceed the cap");

    // Second answer: the durable child is adopted - bound, titled, in a tab.
    await act(() => button?.click());
    await flushUntil(() => consoleStore.state.sessions.length === 2);
    const child = consoleStore.state.sessions.find((session) => session.id !== localId);
    expect(child?.durableSessionId).toBe("child-1");
    expect(child?.title).toBe("Fork of durable");
    expect(consoleStore.state.tabs.map((tab) => tab.place)).toContainEqual({
      kind: "session",
      sessionId: child?.id ?? "",
    });

    // A dying socket: the transport failure reaches the composer, not the void.
    // Adoption switched the active tab to the child; wait for ITS fork control
    // (the child's page also carries a boundary anchor) before clicking.
    const forkControl = () => host.querySelector<HTMLElement>('[data-ui="SessionContent.Fork"]');
    await flushUntil(() => forkControl() !== null);
    await act(() => forkControl()?.click());
    await flushUntil(() => host.textContent?.includes("gateway socket closed") === true);
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreGlobals();
    await window.happyDOM.close();
    server.stop(true);
    client.clear();
  }
});
