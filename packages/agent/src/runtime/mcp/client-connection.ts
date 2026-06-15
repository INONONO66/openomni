import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpClientHandle } from "./client-types";

export interface TransportCloseTracker {
  readonly isClosed: () => boolean;
}

export function trackTransportCloseRequests(transport: Transport): TransportCloseTracker {
  let closeRequested = false;
  const close = transport.close.bind(transport);
  transport.close = async () => {
    closeRequested = true;
    await close();
  };

  return {
    isClosed: () => closeRequested,
  };
}

export async function cleanupFailedConnection(
  client: McpClientHandle,
  transport: Transport,
  closeTracker?: TransportCloseTracker,
): Promise<unknown | undefined> {
  let cleanupError: unknown;
  try {
    await client.close();
  } catch (err) {
    cleanupError = err;
  }

  if (!closeTracker?.isClosed()) {
    try {
      await transport.close();
    } catch (err) {
      cleanupError ??= err;
    }
  }

  return cleanupError;
}
