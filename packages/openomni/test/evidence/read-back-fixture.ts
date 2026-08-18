import { createServer, type Server, type ServerResponse } from "node:http";
import { expect } from "bun:test";
import { Storage } from "@openomni/ledger";
import type { ReadBackExecutor } from "../../src/evidence/read-back-executor";

const servers: Server[] = [];
const hangingResponses: ServerResponse[] = [];
const slowTimers: ReturnType<typeof setInterval>[] = [];

export const LOCAL_READ_BACK = { allowPrivateNetwork: true } satisfies ReadBackExecutor.Options;

export async function startFixtureServer(): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ? new URL(request.url, "http://127.0.0.1").pathname : "/";
    if (path === "/document") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("The source contains a quoted passage for citation checks.");
      return;
    }
    if (path === "/api/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, method: request.method }));
      return;
    }
    if (path === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x61]));
      return;
    }
    if (path === "/slow") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      hangingResponses.push(response);
      slowTimers.push(setInterval(() => response.write("x"), 5));
      return;
    }
    if (path === "/large") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("x".repeat(1_000_001));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("missing");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fixture server did not bind to a TCP port");
  }
  servers.push(server);
  return `http://127.0.0.1:${address.port}`;
}

export async function closeFixtureServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(closeServer));
}

export async function cleanupReadBackFixtures(): Promise<void> {
  Storage.reset();
  for (const timer of slowTimers.splice(0)) {
    clearInterval(timer);
  }
  for (const response of hangingResponses.splice(0)) {
    response.destroy();
  }
  await closeFixtureServers();
}

export async function expectRejects(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return;
  }
  throw new Error("expected operation to reject");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    }
  });
}
