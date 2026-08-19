import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { parseMcpServerConfigs, type McpServerConfig } from "../config/mcp-server-config";

const discoverCache = new Map<string, { result: McpServerConfig[] | null }>();

export namespace McpConfigLoader {
  /**
   * Project MCP config, read during boot. `traceId` is the boot's — discovery
   * is not a trace origin, and a parse warning filed under a minted id cannot
   * be read back against the startup that produced it.
   */
  export function discover(workspaceRoot: string, traceId: string): McpServerConfig[] | null {
    const cached = discoverCache.get(workspaceRoot);
    if (cached) return cached.result;

    const configPath = join(workspaceRoot, ".openomni", "mcp.json");
    if (!existsSync(configPath)) {
      discoverCache.set(workspaceRoot, { result: null });
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      Bus.publish(
        Operational.Events.Warn,
        Operational.envelope({
          traceId,
          component: "server",
          msg: "failed to parse mcp config",
          context: { configPath },
        }),
      );
      discoverCache.set(workspaceRoot, { result: null });
      return null;
    }

    let result: McpServerConfig[] | null;

    if (Array.isArray(parsed)) {
      result = parseMcpServerConfigs(parsed, { source: "project-config", configPath, traceId });
    } else if (parsed !== null && typeof parsed === "object" && "servers" in parsed) {
      result = parseMcpServerConfigs((parsed as { servers: unknown }).servers, {
        source: "project-config",
        configPath,
        traceId,
      });
    } else {
      Bus.publish(
        Operational.Events.Warn,
        Operational.envelope({
          traceId,
          component: "server",
          msg: "unexpected format in mcp config",
          context: { configPath },
        }),
      );
      result = null;
    }

    discoverCache.set(workspaceRoot, { result });
    return result;
  }

  export function merge(
    global: McpServerConfig[],
    project: McpServerConfig[] | null,
  ): McpServerConfig[] {
    if (project === null) return global;

    const byName = new Map<string, McpServerConfig>(global.map((s) => [s.name, s]));
    for (const server of project) {
      byName.set(server.name, server);
    }

    return [...byName.values()];
  }
}
