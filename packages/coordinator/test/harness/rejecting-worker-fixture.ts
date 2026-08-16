import { appendFileSync } from "node:fs";

// A worker whose bootstrap always REJECTS, on a raw socket so every client
// open/close is countable: the supervisor's connect loop must close each
// failed attempt's client instead of leaking it. The test derives the peak
// number of concurrently-live clients from the open/close log.
function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const socketPath = readCliArg("--socket");
if (!socketPath) {
  console.error("rejecting-worker-fixture: missing --socket");
  process.exit(1);
}
// The worker env is allowlisted, so the observable log path is derived from
// the one channel the supervisor already provides: the socket path.
const logPath = `${socketPath}.log`;

Bun.listen<{ buffer: string }>({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.data = { buffer: "" };
      appendFileSync(logPath, "open\n");
    },
    close() {
      appendFileSync(logPath, "close\n");
    },
    data(socket, chunk) {
      socket.data.buffer += chunk.toString();
      let newline = socket.data.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = socket.data.buffer.slice(0, newline);
        socket.data.buffer = socket.data.buffer.slice(newline + 1);
        newline = socket.data.buffer.indexOf("\n");
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as { type?: string; id?: string; method?: string };
        if (message.type === "request" && message.id !== undefined) {
          socket.write(
            `${JSON.stringify({ v: 2, type: "response", id: message.id, result: { ok: false, error: "rejected by fixture" } })}\n`,
          );
        }
      }
    },
  },
});

setInterval(() => {
  // Keep the process alive; the supervisor kills it on stop().
}, 1_000);
