export interface HealthServer {
  readonly port: number;
  stop(): void;
}

export function createHealthServer(port: number): HealthServer {
  const server = Bun.serve({
    port,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return Response.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    get port() {
      return server.port!;
    },
    stop() {
      server.stop();
    },
  };
}
