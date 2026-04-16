import { Daemon } from "@openomni/protocol";

export type DaemonClient = {
  send(cmd: Daemon.Command): void;
  onEvent(handler: (event: Daemon.Event) => void): () => void;
  close(): void;
};

export async function connectToDaemon(wsUrl: string, timeoutMs = 5000): Promise<DaemonClient> {
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Connection timeout")), timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };
  });

  const handlers = new Set<(event: Daemon.Event) => void>();
  ws.onmessage = (e) => {
    try {
      const event = Daemon.Event.parse(JSON.parse(e.data as string));
      handlers.forEach((h) => h(event));
    } catch {
      // ignore parse errors — daemon may send unknown message types
    }
  };

  return {
    send(cmd) {
      ws.send(JSON.stringify(cmd));
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      ws.close();
    },
  };
}
