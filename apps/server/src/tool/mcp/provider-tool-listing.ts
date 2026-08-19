import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { NativeTool } from "@openomni/openomni";
import { mcpToolMetadata } from "./provider-metadata";
import type { McpClientLike } from "./provider-types";

function createAbortError(): Error {
  const error = new Error("MCP tool execution aborted");
  error.name = "AbortError";
  return error;
}

export async function refreshMcpTools(
  clients: ReadonlyMap<string, McpClientLike>,
  traceId: string,
): Promise<NativeTool[]> {
  const tools: NativeTool[] = [];
  for (const [serverName, client] of clients) {
    try {
      const specs = await client.listTools();
      for (const spec of specs) {
        const metadata = mcpToolMetadata(serverName, spec);
        tools.push({
          spec: { ...spec, labels: metadata.labels },
          labels: metadata.labels,
          descriptor: metadata.descriptor,
          riskTier: 1,
          isReadOnly: false,
          isDestructive: false,
          isConcurrencySafe: false,
          source: "mcp",
          execute: (call, context) => {
            if (context?.signal?.aborted) return Promise.reject(createAbortError());
            return client.callTool(call.tool, call.input, call.id, context);
          },
        });
      }
    } catch (err) {
      Bus.publish(
        Operational.Events.Warn,
        Operational.envelope({
          traceId,
          component: "server",
          msg: "failed to list tools from mcp server",
          context: {
            serverName,
            err: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    }
  }
  return tools;
}
