import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { Ipc } from "@openomni/protocol";
import { LineDecoder } from "../src/framing";
import { createIpcServer } from "../src/server";
import { deferred, within } from "./helpers/signal";
import { socketPath as socketPathForTest } from "./helpers/socket-path";

// Big enough to overflow any kernel socket buffer: Bun sockets do NOT buffer
// partial writes, so pre-fix the tail of this frame was silently dropped.
const BIG_PAYLOAD = "x".repeat(8 * 1024 * 1024);

describe("server write backpressure (Bun partial writes)", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const rawSockets: net.Socket[] = [];

  afterEach(() => {
    for (const s of rawSockets.splice(0)) s.destroy();
    for (const s of servers.splice(0)) s.close();
  });

  test("a multi-megabyte response reaches a slow reader byte-exact", async () => {
    const socketPath = socketPathForTest("big-frame");
    const responseIssued = deferred();
    const srv = await createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ data: BIG_PAYLOAD });
      responseIssued.resolve();
    });
    servers.push(srv);

    const socket = net.createConnection(socketPath);
    rawSockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    // Slow reader: stop consuming BEFORE the server writes. The kernel
    // accepts only one socket buffer's worth synchronously; everything
    // else must survive in the server's write queue until drain.
    const decoder = new LineDecoder();
    const frameReceived = deferred<unknown>();
    socket.on("data", (chunk) => {
      const { frames } = decoder.push(chunk);
      if (frames.length > 0) frameReceived.resolve(frames[0]);
    });
    socket.pause();
    const request = Ipc.createRequest("request-big-1", "get-big", {});
    socket.write(`${JSON.stringify(request)}\n`);
    await within(responseIssued.promise, "server issuing queued large response");
    socket.resume();
    const frame = await within(frameReceived.promise, "complete large response", 10_000);

    const response = frame as { id?: string; result?: { data?: string } };
    expect(response.id).toBe(request.id);
    // Byte-exact receipt — pre-fix the frame arrived truncated, desyncing
    // the NDJSON stream. Compare via boolean so a failure doesn't dump 8 MiB.
    expect(response.result?.data?.length).toBe(BIG_PAYLOAD.length);
    expect(response.result?.data === BIG_PAYLOAD).toBe(true);
  }, 15_000);

  test("a frame written while earlier bytes are still queued arrives after them, intact", async () => {
    const socketPath = socketPathForTest("ordering");
    const responseIssued = deferred();
    const srv = await createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ data: BIG_PAYLOAD });
      responseIssued.resolve();
    });
    servers.push(srv);

    const socket = net.createConnection(socketPath);
    rawSockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    const decoder = new LineDecoder();
    const frames: unknown[] = [];
    const bothFramesReceived = deferred();
    socket.on("data", (chunk) => {
      frames.push(...decoder.push(chunk).frames);
      if (frames.length >= 2) bothFramesReceived.resolve();
    });
    socket.pause();
    const request = Ipc.createRequest("request-big-2", "get-big", {});
    socket.write(`${JSON.stringify(request)}\n`);
    await within(responseIssued.promise, "server queuing first large frame");

    // The big response is now partially queued. A notification issued NOW
    // must land after it — pre-fix it interleaved into the middle of the
    // queued frame and corrupted both.
    expect(srv.notify("after.big", { marker: true })).toBe(true);
    socket.resume();
    await within(bothFramesReceived.promise, "ordered response and notification", 10_000);

    const [first, second] = frames as [
      { id?: string; result?: { data?: string } },
      { type?: string; method?: string; params?: { marker?: boolean } },
    ];
    expect(first.id).toBe(request.id);
    expect(first.result?.data === BIG_PAYLOAD).toBe(true);
    expect(second.type).toBe("notification");
    expect(second.method).toBe("after.big");
    expect(second.params).toEqual({ marker: true });
  }, 15_000);
});
