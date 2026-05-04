import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface FakeCoordinator {
  socketPath: string;
  close: () => Promise<void>;
  received: object[];
}

export interface FakeWorker {
  close: () => void;
}

export function createFakeCoordinator(): Promise<FakeCoordinator> {
  const socketPath = path.join(os.tmpdir(), `fake-coordinator-${Date.now()}.sock`);
  const received: object[] = [];

  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as object;
            received.push(msg);
            conn.write(`${JSON.stringify({ echo: msg })}\n`);
          } catch {
            conn.write(`${JSON.stringify({ error: "parse_error" })}\n`);
          }
        }
      });
    });

    server.listen(socketPath, () => {
      resolve({
        socketPath,
        received,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });

    server.once("error", reject);
  });
}

export function createFakeWorker(socketPath: string): Promise<FakeWorker> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
      resolve({ close: () => socket.destroy() });
    });

    socket.once("error", reject);
  });
}
