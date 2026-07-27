import type { McpToolProvider } from "../tool/mcp";
import type { IncidentSink } from "../server/incidents";

export interface ShutdownDeps {
  readonly ingress: { stop(): void | Promise<void> };
  readonly channels: ReadonlyArray<{ stop(): void | Promise<void> }>;
  readonly server: { stop(force: boolean): void };
  readonly mcpProvider: Pick<McpToolProvider, "disconnectAll">;
  readonly coordinator: { shutdown(): Promise<void> };
  readonly cronRunner: { stop(): void };
  readonly runtime: { close(): Promise<void> };
  readonly incidents: IncidentSink;
  readonly exit: (code: number) => void;
}

/** Testable ordered shutdown. Runtime.close owns FIFO drain, DB close, and credential disposal. */
export async function shutdownP2Runtime(deps: ShutdownDeps, reason: string): Promise<void> {
  try {
    await deps.ingress.stop();
    for (const channel of deps.channels) await channel.stop();
    deps.server.stop(true);
    deps.cronRunner.stop();
    await deps.coordinator.shutdown();
    await deps.mcpProvider.disconnectAll();
    await deps.runtime.close();
    deps.incidents.dispose();
    deps.exit(0);
  } catch (error) {
    deps.incidents.report({
      component: "server",
      summary: "server error during shutdown",
      data: { reason, error },
    });
    deps.incidents.dispose();
    deps.exit(1);
  }
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  let _shutdown: Promise<void> | undefined;
  const begin = (reason: string): void => {
    _shutdown ??= shutdownP2Runtime(deps, reason);
  };
  process.on("SIGTERM", () => begin("SIGTERM"));
  process.on("SIGINT", () => begin("SIGINT"));
}
