export type WsCommandHandler = (
  cmd: Record<string, unknown>,
  send: (msg: Record<string, unknown>) => void,
) => void;

export interface DaemonWsServer {
  readonly port: number;
  stop(): void;
}

export function createDaemonWsServer(port: number, handler: WsCommandHandler): DaemonWsServer {
  const server = Bun.serve({
    port,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        let cmd: Record<string, unknown>;
        try {
          cmd = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
          return;
        }
        handler(cmd, (msg) => ws.send(JSON.stringify(msg)));
      },
    },
  });

  return {
    get port() {
      return server.port ?? port;
    },
    stop() {
      server.stop();
    },
  };
}
