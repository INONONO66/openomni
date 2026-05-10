import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { ServerConfig } from "../config.js";

type McpServerConfig = ServerConfig["mcp"]["servers"][number];

const discoverCache = new Map<string, { result: McpServerConfig[] | null }>();

export namespace McpConfigLoader {
  export function discover(workspaceRoot: string): McpServerConfig[] | null {
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
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "failed to parse mcp config",
        context: { configPath },
      });
      discoverCache.set(workspaceRoot, { result: null });
      return null;
    }

    let result: McpServerConfig[] | null;

    if (Array.isArray(parsed)) {
      result = parsed.filter(
        (e): e is McpServerConfig =>
          e !== null && typeof e === "object" && typeof (e as { name?: unknown }).name === "string",
      );
    } else if (
      parsed !== null &&
      typeof parsed === "object" &&
      "servers" in parsed &&
      Array.isArray((parsed as { servers: unknown }).servers)
    ) {
      result = (parsed as { servers: McpServerConfig[] }).servers;
    } else {
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "unexpected format in mcp config",
        context: { configPath },
      });
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

  export function _resetCache(): void {
    discoverCache.clear();
  }
}
