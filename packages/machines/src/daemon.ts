import { type IpcClient, connectIpcClient, typedCall } from "@openomni/ipc";
import { Machine } from "@openomni/protocol";
import { PythonKernel } from "./kernel";

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
 * connection IS the attachment. A daemon that offers `kernel.py` serves cells
 * over the reverse request channel using one attachment-scoped interpreter.
 */
export async function attachMachineDaemon(options: MachineDaemonOptions): Promise<MachineDaemon> {
  const kernel = options.offer.offeredCapabilities.includes("kernel.py")
    ? new PythonKernel()
    : undefined;
  const client: IpcClient = await connectIpcClient(options.socketPath, {
    onRequest: async (method, params, respond) => {
      if (method !== Machine.WireMethod.RunCell || kernel === undefined) {
        throw new Error(`unknown method: ${method}`);
      }
      const request = Machine.CellRequest.parse(params);
      respond(await kernel.run(request));
    },
  });
  try {
    // typedCall types the wire result but does not validate it; the host is
    // across a trust boundary, so parse before believing it.
    const attachment = Machine.AttachResult.parse(
      await typedCall(client, Machine.WireMethod.Attach, options.offer, options.attachTimeoutMs),
    );
    return {
      attachment,
      close() {
        kernel?.close();
        client.close();
      },
    };
  } catch (error) {
    kernel?.close();
    client.close();
    throw error;
  }
}
