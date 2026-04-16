import { MetricsRegistry, collectMetrics, type MetricsSnapshot } from "../metrics/index.js";
import { measureEventLoopLag } from "../metrics/event-loop.js";

export interface HealthServer {
  readonly port: number;
  stop(): void;
}

export type HealthServerOptions = {
  getStats?: () => Omit<MetricsSnapshot, "memoryRssMb" | "eventLoopLagMs">;
};

export function createHealthServer(port: number, options: HealthServerOptions = {}): HealthServer {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const { pathname } = new URL(req.url);

      if (pathname === "/health") {
        return Response.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
      }

      if (pathname === "/metrics") {
        const [lagMs] = await Promise.all([measureEventLoopLag()]);
        const poolStats = options.getStats?.() ?? { activeRuns: 0, queueDepth: 0, workers: 0 };
        const registry = new MetricsRegistry();
        collectMetrics(registry, {
          ...poolStats,
          memoryRssMb: process.memoryUsage().rss / 1024 / 1024,
          eventLoopLagMs: lagMs,
        });
        return new Response(registry.format(), {
          headers: { "Content-Type": "text/plain; version=0.0.4" },
        });
      }

      return new Response("Not Found", { status: 404 });
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
