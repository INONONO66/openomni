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
 * connection IS the attachment. A daemon that offers the Python-kernel
 * capability serves cells over the reverse request channel with one
 * interpreter PER TENANT: a Python process gives no in-process isolation, so
 * the only way to keep one session's cells (their state, and any thread they
 * leave behind) out of another session's way is a process boundary.
 */
export async function attachMachineDaemon(options: MachineDaemonOptions): Promise<MachineDaemon> {
  const offersKernel = options.offer.offeredCapabilities.includes(
    Machine.WellKnownCapability.pythonKernel,
  );
  const kernels = new Map<string, PythonKernel>();
  const kernelFor = (tenant: string | undefined): PythonKernel => {
    const key = tenant ?? "default";
    let kernel = kernels.get(key);
    if (kernel === undefined) {
      kernel = new PythonKernel();
      kernels.set(key, kernel);
    }
    return kernel;
  };
  const closeKernels = () => {
    for (const kernel of kernels.values()) kernel.close();
    kernels.clear();
  };
  // Assigned before any request can arrive: the host can only send RunCell
  // over a connection this call establishes.
  let client!: IpcClient;
  client = await connectIpcClient(options.socketPath, {
    onRequest: async (method, params, respond) => {
      if (method !== Machine.WireMethod.RunCell) {
        throw new Error(`unknown method: ${method}`);
      }
      // The host gate owns this refusal; a daemon that never offered the Python-kernel capability
      // still re-checks because the host is across a trust boundary.
      if (!offersKernel) {
        throw new Error(`${Machine.WellKnownCapability.pythonKernel} was not offered by this machine`);
      }
      const request = Machine.CellRequest.parse(params);
      respond(
        await kernelFor(request.tenant).run(request, async (call) =>
          Machine.ToolCallResult.parse(
            await typedCall(client, Machine.WireMethod.CallTool, call, request.timeoutMs),
          ),
        ),
      );
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
        closeKernels();
        client.close();
      },
    };
  } catch (error) {
    closeKernels();
    client.close();
    throw error;
  }
}
