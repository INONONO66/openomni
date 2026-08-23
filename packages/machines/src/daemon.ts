import { type IpcClient, connectIpcClient, typedCall } from "@openomni/ipc";
import type { Machine } from "@openomni/protocol";

export interface MachineDaemonOptions {
  readonly socketPath: string;
  readonly offer: Machine.Offer;
  readonly attachTimeoutMs?: number;
}

export interface MachineDaemon {
  /** The host's verdict — a refusal is a typed outcome, not a thrown error. */
  readonly attachment: Machine.AttachResult;
  close(): void;
}

/**
 * Machine-side daemon for the localhost slice: connect to the host socket,
 * offer the capability set, and hold the connection open — the live
 * connection IS the attachment. Capability execution arrives in a later
 * slice over this same connection.
 */
export async function attachMachineDaemon(options: MachineDaemonOptions): Promise<MachineDaemon> {
  const client: IpcClient = await connectIpcClient(options.socketPath);
  try {
    const attachment = await typedCall(
      client,
      "machine.attach",
      options.offer,
      options.attachTimeoutMs,
    );
    return {
      attachment,
      close() {
        client.close();
      },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
