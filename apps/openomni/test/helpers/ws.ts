import { type PlainObject, PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";

const Frame = z.record(z.string(), PlainValueSchema);

/**
 * Shared WebSocket test plumbing: every wait is an exact-event subscription
 * with a bounded timeout that only ever fails the test.
 */

/** Resolves when the socket opens; rejects on error or after `timeoutMs`. */
function opened(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`WebSocket open timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket failed before opening"));
      },
      { once: true },
    );
  });
}

/** Opens a socket to `url` and resolves once it is connected. */
export async function openSocket(
  url: string,
  protocols: string[],
  timeoutMs = 2000,
): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols);
  try {
    await opened(ws, timeoutMs);
  } catch (error) {
    await closeSocket(ws, timeoutMs);
    throw error;
  }
  return ws;
}

/** Subscribe before closing and await the transport's completion, including failed opens. */
export function closeSocket(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timed out")), timeoutMs);
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.close();
  });
}

/** The next application message/error; an admission receipt is not a response. */
export function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`WebSocket reply timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const listener = (event: MessageEvent) => {
      const frame = Frame.parse(JSON.parse(String(event.data)));
      if (frame.type !== "message" && frame.type !== "error") return;
      clearTimeout(timeout);
      ws.removeEventListener("message", listener);
      resolve(event);
    };
    ws.addEventListener("message", listener);
  });
}

/** The next JSON frame the predicate accepts; earlier frames are skipped. */
export function nextFrame(
  ws: WebSocket,
  accept: (frame: PlainObject) => boolean,
  timeoutMs = 10_000,
): Promise<PlainObject> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no accepted frame arrived within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const listener = (event: MessageEvent) => {
      const frame = Frame.parse(JSON.parse(String(event.data)));
      if (!accept(frame)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", listener);
      resolve(frame);
    };
    ws.addEventListener("message", listener);
  });
}
