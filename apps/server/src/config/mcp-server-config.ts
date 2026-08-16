import { McpConfig, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { z } from "zod";

export type McpServerConfig = McpConfig.ServerConfig;

const MAX_ZOD_ISSUES_PER_ENTRY = 3;

const McpServerConfigParseOptionsSchema = z.object({
  source: z.enum(["server-config", "project-config"]),
  configPath: z.string().optional(),
  /** The caller's trace (boot/config load) — parsing is never a trace origin. */
  traceId: z.string(),
});
export type McpServerConfigParseOptions = z.infer<typeof McpServerConfigParseOptionsSchema>;

export function parseMcpServerConfigs(
  value: unknown,
  options: McpServerConfigParseOptions,
): McpServerConfig[] {
  const parseOptions = McpServerConfigParseOptionsSchema.parse(options);
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    publishInvalidMcpConfigWarning(parseOptions, [
      { index: -1, error: "servers must be an array" },
    ]);
    return [];
  }

  const servers: McpServerConfig[] = [];
  const rejected: Array<{
    readonly index: number;
    readonly name?: string;
    readonly error: string;
  }> = [];

  value.forEach((entry, index) => {
    const parsed = McpConfig.ServerConfig.safeParse(entry);
    if (parsed.success) {
      servers.push(parsed.data);
      return;
    }

    rejected.push({
      index,
      ...readMcpServerName(entry),
      error: parsed.error.issues
        .slice(0, MAX_ZOD_ISSUES_PER_ENTRY)
        .map((issue) => issue.message)
        .join("; "),
    });
  });

  if (rejected.length > 0) {
    publishInvalidMcpConfigWarning(parseOptions, rejected);
  }

  return servers;
}

function publishInvalidMcpConfigWarning(
  options: McpServerConfigParseOptions,
  rejected: ReadonlyArray<{
    readonly index: number;
    readonly name?: string;
    readonly error: string;
  }>,
): void {
  Bus.publish(Operational.Warn, {
    traceId: options.traceId,
    time: Date.now(),
    component: "server",
    msg: "invalid mcp server config ignored",
    context: {
      source: options.source,
      ...(options.configPath !== undefined && { configPath: options.configPath }),
      rejected,
    },
  });
}

function readMcpServerName(entry: unknown): { readonly name?: string } {
  if (entry === null || typeof entry !== "object") return {};
  const name = (entry as { readonly name?: unknown }).name;
  return typeof name === "string" ? { name } : {};
}
