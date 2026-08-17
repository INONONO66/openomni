import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Ipc } from "@openomni/protocol";
import { LineDecoder } from "../src/framing";
import { createIpcServer } from "../src/server";

function tmpSocketPath(label: string): string {
  return path.join(os.tmpdir(), `omo-ipc-bp-${label}-${process.pid}.sock`);
}

// Big enough to overflow any kernel socket buffer: Bun sockets do NOT buffer
// partial writes, so pre-fix the tail of this frame was silently dropped.
const BIG_PAYLOAD = "x".repeat(8 * 1024 * 1024);

describe("server write backpressure (Bun partial writes)", () => {
  const servers: Awaited<ReturnType<typeof createIpcServer>>[] = [];
  const rawSockets: net.Socket[] = [];

  afterEach(async () => {
    for (const s of rawSockets.splice(0)) s.destroy();
    for (const s of servers.splice(0)) s.close();
    await Bun.sleep(10);
  });

  test("a multi-megabyte response reaches a slow reader byte-exact", async () => {
    const socketPath = tmpSocketPath("big-frame");
    const srv = await createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ data: BIG_PAYLOAD });
    });
    servers.push(srv);

    const socket = net.createConnection(socketPath);
    rawSockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    // Slow reader: stop consuming BEFORE the server writes. The kernel
    // accepts only one socket buffer's worth synchronously; everything
    // else must survive in the server's write queue until drain.
    socket.pause();
    const request = Ipc.createRequest("get-big", {});
    socket.write(`${JSON.stringify(request)}\n`);
    await Bun.sleep(300);

    const decoder = new LineDecoder();
    const frame = await new Promise<unknown>((resolve) => {
      socket.on("data", (chunk) => {
        const { frames } = decoder.push(chunk);
        if (frames.length > 0) resolve(frames[0]);
      });
      socket.resume();
    });

    const response = frame as { id?: string; result?: { data?: string } };
    expect(response.id).toBe(request.id);
    // Byte-exact receipt — pre-fix the frame arrived truncated, desyncing
    // the NDJSON stream. Compare via boolean so a failure doesn't dump 8 MiB.
    expect(response.result?.data?.length).toBe(BIG_PAYLOAD.length);
    expect(response.result?.data === BIG_PAYLOAD).toBe(true);
  }, 15_000);

  test("a frame written while earlier bytes are still queued arrives after them, intact", async () => {
    const socketPath = tmpSocketPath("ordering");
    const srv = await createIpcServer(socketPath, (_method, _params, respond) => {
      respond({ data: BIG_PAYLOAD });
    });
    servers.push(srv);

    const socket = net.createConnection(socketPath);
    rawSockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    socket.pause();
    const request = Ipc.createRequest("get-big", {});
    socket.write(`${JSON.stringify(request)}\n`);
    await Bun.sleep(200);

    // The big response is now partially queued. A notification issued NOW
    // must land after it — pre-fix it interleaved into the middle of the
    // queued frame and corrupted both.
    expect(srv.notify("after.big", { marker: true })).toBe(true);

    const decoder = new LineDecoder();
    const frames: unknown[] = [];
    await new Promise<void>((resolve) => {
      socket.on("data", (chunk) => {
        frames.push(...decoder.push(chunk).frames);
        if (frames.length >= 2) resolve();
      });
      socket.resume();
    });

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
