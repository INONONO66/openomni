import { beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { notifyManager, QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { z } from "zod";
import { App } from "../src/renderer/app";
import { StateProvider } from "../src/renderer/state/provider";
import { queryKeys } from "../src/renderer/state/queries";
import { bindDurableSession } from "../src/renderer/state/session-actions";
import { consoleStore, INITIAL_CLIENT_STATE, newSessionTab } from "../src/renderer/state/store";
import { installGlobals, mountWindow } from "./helpers";
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

/** The one allowed timer: a failure BOUND on an already-awaited signal, never a wait. */
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out awaiting ${label}`)), 5000);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const clientFrame = z.record(z.string(), z.json());
type ClientFrame = z.infer<typeof clientFrame>;
const frameListeners = new Set<(frame: ClientFrame) => void>();
const closeListeners = new Set<() => void>();

/**
 * The renderer's real socket, observed: every server frame the CLIENT receives
 * and every close it sees also notifies the test's listeners, so a test can
 * subscribe to the exact wire event BEFORE acting instead of polling renders.
 */
class ObservedWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener("message", (event) => {
      const frame = clientFrame.parse(JSON.parse(String(event.data)));
      for (const listener of frameListeners) listener(frame);
    });
    this.addEventListener("close", () => {
      for (const listener of closeListeners) listener();
    });
  }
}

/** Resolves on the next client-received frame matching `predicate`; subscribe before acting. */
function frameSignal(predicate: (frame: ClientFrame) => boolean, label: string): Promise<void> {
  return bounded(
    new Promise<void>((resolve) => {
      const listener = (frame: ClientFrame) => {
        if (!predicate(frame)) return;
        frameListeners.delete(listener);
        resolve();
      };
      frameListeners.add(listener);
    }),
    label,
  );
}

/** Resolves when the client socket closes; subscribe before acting. */
function closeSignal(label: string): Promise<void> {
  return bounded(
    new Promise<void>((resolve) => {
      const listener = () => {
        closeListeners.delete(listener);
        resolve();
      };
      closeListeners.add(listener);
    }),
    label,
  );
}

/** Resolves when the console store satisfies `predicate`; subscribe before acting. */
function storeSignal(predicate: () => boolean, label: string): Promise<void> {
  return bounded(
    new Promise<void>((resolve) => {
      if (predicate()) {
        resolve();
        return;
      }
      const subscription = consoleStore.subscribe(() => {
        if (!predicate()) return;
        subscription.unsubscribe();
        resolve();
      });
    }),
    label,
  );
}

/** Resolves when the read page for `sessionId` lands in the query cache. */
function pageSignal(client: QueryClient, sessionId: string): Promise<void> {
  return bounded(
    new Promise<void>((resolve) => {
      if (client.getQueryData(queryKeys.session(sessionId)) !== undefined) {
        resolve();
        return;
      }
      const unsubscribe = client.getQueryCache().subscribe((event) => {
        if (event.query.queryKey.at(-1) !== sessionId || event.query.state.data === undefined) return;
        unsubscribe();
        resolve();
      });
    }),
    `read page for ${sessionId}`,
  );
}

/**
 * Await `signal` INSIDE `act`. The signal is a wire/store fact that resolves
 * without React, so the queued act work cannot deadlock on it; the extra
 * microtask turn lets the transport's promise chain run `setState` before the
 * act exit flushes the render.
 */
async function settled(signal: Promise<void>, after?: () => void): Promise<void> {
  await act(async () => {
    after?.();
    await signal;
    await Promise.resolve();
  });
}

test("the desktop fork control adopts the gateway's child and surfaces typed refusals", async () => {
  const server = serveFork();
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  const restoreSocket = installGlobals({ WebSocket: ObservedWebSocket });
  const client = new QueryClient();
  const localId = newSessionTab();
  bindDurableSession(localId, "durable");
  client.setQueryData(queryKeys.gatewayEndpoint, { url: `ws://127.0.0.1:${server.port}` });
  // Synchronous query notifications: the cache event, the React setState and
  // the act-queue entry land in ONE frame, so an awaited cache signal inside
  // `act` deterministically renders at the act exit (no scheduler races).
  notifyManager.setScheduler((callback) => callback());
  try {
    const parentPaged = pageSignal(client, "durable");
    await act(() =>
      root.render(
        <StateProvider client={client}>
          <App platform="darwin" storage={null} host={testPlatform} />
        </StateProvider>,
      ),
    );
    // The page's boundary anchor earns the fork control.
    await settled(parentPaged);
    const button = host.querySelector<HTMLElement>('[data-ui="SessionContent.Fork"]');
    expect(button).not.toBeNull();

    // First answer: the typed refusal reaches the composer as a sentence.
    await settled(
      frameSignal((frame) => frame.type === "session_fork_refused", "fork refusal"),
      () => button?.click(),
    );
    expect(host.textContent).toContain("fork refused: byte_cap");
    expect(host.textContent).toContain("copied bytes exceed the cap");

    // Second answer: the durable child is adopted - bound, titled, in a tab.
    await settled(
      storeSignal(() => consoleStore.state.sessions.length === 2, "child adoption"),
      () => button?.click(),
    );
    const child = consoleStore.state.sessions.find((session) => session.id !== localId);
    expect(child?.durableSessionId).toBe("child-1");
    expect(child?.title).toBe("Fork of durable");
    expect(consoleStore.state.tabs.map((tab) => tab.place)).toContainEqual({
      kind: "session",
      sessionId: child?.id ?? "",
    });

    // A dying socket: the transport failure reaches the composer, not the void.
    // Adoption switched the active tab to the child; wait for ITS read page
    // (it also carries a boundary anchor) to earn the child's fork control.
    await settled(pageSignal(client, "child-1"));
    const forkControl = host.querySelector<HTMLElement>('[data-ui="SessionContent.Fork"]');
    expect(forkControl).not.toBeNull();
    await settled(closeSignal("socket drain"), () => forkControl?.click());
    expect(host.textContent).toContain("gateway socket closed");
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreSocket();
    restoreGlobals();
    await window.happyDOM.close();
    server.stop(true);
    client.clear();
    // The library default (restored for the rest of the suite's files).
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  }
}, 20_000);
