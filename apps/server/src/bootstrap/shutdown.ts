import { Operational } from "@openomni/protocol";
import { Storage, BusPersistence } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { newTraceId } from "@openomni/telemetry";
import type { McpToolProvider } from "../tool/mcp";

interface ClosableStorage {
  close(): void;
}

function isClosableStorage(storage: unknown): storage is ClosableStorage {
  if (storage == null || typeof storage !== "object") return false;
  return typeof (storage as Record<string, unknown>).close === "function";
}

interface ShutdownDeps {
  channels: Array<{ stop(traceId: string): void }>;
  server: { stop(force: boolean): void };
  mcpProvider: McpToolProvider;
  coordinator?: { shutdown(): Promise<void> };
  cronRunner?: { stop(): void };
  traceId?: string;
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  let shuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    const traceId = deps.traceId ?? newTraceId();
    Bus.publish(Operational.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "server shutting down",
    });

    Bus.publish(Operational.ShutdownInitiated, {
      traceId,
      reason,
      time: Date.now(),
    });

    try {
      deps.cronRunner?.stop();
      await deps.coordinator?.shutdown();

      for (const channel of deps.channels) {
        channel.stop(traceId);
      }

      deps.server.stop(true);
      await deps.mcpProvider.disconnectAll();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      // Accepted-append drain (#510 D1). Decision-class appends need no
      // drain of their own: they run inside synchronous bun:sqlite
      // transactions, which the event loop cannot interleave — reaching
      // this line proves no decision transaction is mid-flight. The drain
      // is therefore (1) flushing the queued NORMAL/group-commit telemetry
      // batch while the observer is still attached, then (2) the final
      // WAL checkpoint (TRUNCATE), which SqliteStorageAdapter.close() runs
      // after closing the telemetry connection.
      await BusPersistence.flush();
      BusPersistence.stop();

      const storage = Storage.get();
      if (isClosableStorage(storage)) {
        storage.close();
      }
    } catch (err) {
      Bus.publish(Operational.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "server error during shutdown",
        context: { err: String(err) },
      });
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}
