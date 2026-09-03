/**
 * Shared WebSocket test plumbing: every wait is an exact-event subscription
 * with a bounded timeout that only ever fails the test.
 */

/** Resolves when the socket opens; rejects on error or after `timeoutMs`. */
export function opened(ws: WebSocket, timeoutMs = 2000): Promise<void> {
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
export async function openSocket(url: string, timeoutMs = 2000): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await opened(ws, timeoutMs);
  return ws;
}

/** The next message event on the socket, whatever it carries. */
export function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`WebSocket reply timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
  });
}

/** The next JSON frame the predicate accepts; earlier frames are skipped. */
export function nextFrame(
  ws: WebSocket,
  accept: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no accepted frame arrived within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const listener = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!accept(frame)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", listener);
      resolve(frame);
    };
    ws.addEventListener("message", listener);
  });
}
