import { Storage } from "@openomni/session";
import type { McpToolProvider } from "../tool/mcp";

interface ClosableStorage {
  transaction(fn: () => void): void;
  close(): void;
  sqlite: { exec(sql: string): void };
}

function isClosableStorage(storage: unknown): storage is ClosableStorage {
  const s = storage as Record<string, unknown>;
  return typeof s.close === "function" && typeof s.transaction === "function" && s.sqlite != null;
}

interface ShutdownDeps {
  channels: Array<{ stop(): void }>;
  server: { stop(force: boolean): void };
  mcpProvider: McpToolProvider;
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("[server] shutting down...");

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

    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
