import { expect } from "bun:test";
import { IpcConnectionError } from "./native";
import { captureError, within } from "./signal";

/**
 * Flood one oversize (17 MiB > the 16 MiB decoder cap) call and require the
 * fast FIN (#606, #1270 F8): the call fails as a connection loss and the
 * server reports the disconnect — long before the 30s call timeout.
 */
export async function expectOversizeFailFast<Reply>(
  client: { call(method: string, params: { data: string }, timeoutMs: number): Promise<Reply> },
  disconnected: Promise<string>,
): Promise<void> {
  const call = client.call("big", { data: "y".repeat(17 * 1024 * 1024) }, 30_000);
  // Observe rejection immediately: FIN must fail the request even with unsent bytes.
  const rejected = captureError(call);
  const [error] = await within(
    Promise.all([rejected, disconnected]), "oversize FIN and server disconnect", 12_000,
  );
  expect(error).toBeInstanceOf(IpcConnectionError);
}
