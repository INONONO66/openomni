import { Operational } from "@openomni/protocol";
import { Storage, Bus, Log } from "@openomni/session";
import type { McpToolProvider } from "../tool/mcp";

interface ClosableStorage {
  transaction(fn: () => void): void;
  close(): void;
  sqlite: { exec(sql: string): void };
}

function isClosableStorage(storage: unknown): storage is ClosableStorage {
  if (storage == null || typeof storage !== "object") return false;
  const s = storage as Record<string, unknown>;
  return typeof s.close === "function" && typeof s.transaction === "function" && s.sqlite != null;
}

interface ShutdownDeps {
  channels: Array<{ stop(): void }>;
  server: { stop(force: boolean): void };
  mcpProvider: McpToolProvider;
  coordinator?: { shutdown(): Promise<void> };
  traceId?: string;
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  let shuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    const traceId = deps.traceId ?? crypto.randomUUID();
    Log.info("server shutting down");

    Bus.publish(Operational.ShutdownInitiated, {
      traceId,
      reason,
      time: Date.now(),
    });

    try {
      await deps.coordinator?.shutdown();

      for (const channel of deps.channels) {
        channel.stop();
      }

      deps.server.stop(true);
      await deps.mcpProvider.disconnectAll();
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      const storage = Storage.get();
      if (isClosableStorage(storage)) {
        storage.transaction(() => {
          storage.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        });
        storage.close();
      }
    } catch (err) {
      Log.error("server error during shutdown", { err: String(err) });
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
