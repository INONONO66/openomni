import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { McpServerConfig } from "@openomni/protocol";

export function requestOptions(
  config: McpServerConfig,
  context?: { readonly signal?: AbortSignal },
): RequestOptions | undefined {
  const timeout = normalizeTimeout(config.timeout);
  if (context?.signal === undefined && timeout === undefined) {
    return undefined;
  }

  return {
    ...(context?.signal !== undefined && { signal: context.signal }),
    ...(timeout !== undefined && { timeout, maxTotalTimeout: timeout }),
  };
}

function normalizeTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}
