import { type IpcClient, connectIpcClient, typedCall } from "@openomni/ipc";
import { Machine } from "@openomni/protocol";
import { MachineDaemonProtocolError } from "./errors";
import { createFsDriver } from "./fs";
import { PYTHON_DRIVER, PythonKernel } from "./kernel";
import {
  type Launcher,
  type SandboxProbe,
  type SandboxProfile,
  probeSandbox,
  sandboxedLauncher,
} from "./launcher";

export interface MachineDaemonOptions {
  readonly socketPath: string;
  readonly offer: Machine.Offer;
  readonly sandbox: SandboxProfile;
  /** Daemon-local export roots; absolute paths never cross the wire. */
  readonly fsExports?: ReadonlyMap<string, string>;
  readonly attachTimeoutMs?: number;
}

export interface MachineDaemon {
  /** The host's verdict — a refusal is a typed outcome, not a thrown error. */
  readonly attachment: Machine.AttachResult;
  readonly sandbox: SandboxProbe;
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
  const sandbox = await probeSandbox(options.sandbox);
  const requestedKernel = options.offer.offeredCapabilities.includes(
    Machine.WellKnownCapability.pythonKernel,
  );
  const nonExecutionCapabilities = options.offer.offeredCapabilities.filter(
    (capability) =>
      capability !== Machine.WellKnownCapability.pythonKernel &&
      capability !== Machine.WellKnownCapability.sandboxProcess,
  );
  const executionCapabilities =
    sandbox.ok && requestedKernel
      ? [Machine.WellKnownCapability.pythonKernel, Machine.WellKnownCapability.sandboxProcess]
      : [];
  const offer: Machine.Offer = {
    ...options.offer,
    offeredCapabilities: [...nonExecutionCapabilities, ...executionCapabilities],
  };
  const offersKernel = executionCapabilities.length > 0;
  const offersFs = offer.offeredCapabilities.includes(Machine.WellKnownCapability.fsRead);
  const offeredExports = new Set((offer.exports ?? []).map((entry) => entry.name));
  const fsOp = createFsDriver(options.fsExports ?? new Map());
  const launch = sandbox.ok ? sandboxedLauncher(options.sandbox, PYTHON_DRIVER) : undefined;
  const kernels = new Map<string, PythonKernel>();
  const kernelFor = (
    tenant: string | undefined,
    profileDigest: string,
    launcher: Launcher,
  ): PythonKernel => {
    const tenantId = tenant ?? "default";
    const key = `${tenantId}::${profileDigest}`;
    let kernel = kernels.get(key);
    if (kernel === undefined) {
      kernel = new PythonKernel({ launch: () => launcher(tenantId) });
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
  let client: IpcClient | undefined;
  // The host can only send requests over the connection this call establishes,
  // so a handler firing before assignment would be a transport bug, not input.
  const requireClient = (): IpcClient => {
    if (client === undefined) {
      throw new Error("machine daemon received a request before its client was connected");
    }
    return client;
  };
  // fsOp already holds open export descriptors, so a failure to connect must
  // release them rather than leak one set of fds per attach attempt.
  const connecting = connectIpcClient(options.socketPath, {
    onRequest: async (method, params, respond) => {
      if (method === Machine.WireMethod.FsOp) {
        // The host gate owns normal authorization; the daemon still re-checks
        // its own offer because the host is across a trust boundary.
        if (!offersFs) {
          const capability = Machine.WellKnownCapability.fsRead;
          throw new MachineDaemonProtocolError({
            reason: "capability_not_offered",
            capability,
            message: `${capability} was not offered by this machine`,
          });
        }
        const request = Machine.FsRequest.parse(params);
        if (!offeredExports.has(request.export)) {
          respond({
            status: "refused",
            reason: "export_not_available",
            message: `export is not available: ${request.export}`,
          } satisfies Machine.FsResult);
          return;
        }
        respond(await fsOp(request));
        return;
      }
      if (method !== Machine.WireMethod.RunCell) {
        throw new Error(`unknown method: ${method}`);
      }
      // The host gate owns this refusal; a daemon that never offered the Python-kernel capability
      // still re-checks because the host is across a trust boundary.
      if (!offersKernel || !sandbox.ok || launch === undefined) {
        throw new Error(
          `${Machine.WellKnownCapability.pythonKernel} was not offered by this machine`,
        );
      }
      const request = Machine.CellRequest.parse(params);
      respond(
        await kernelFor(request.tenant, sandbox.profileDigest, launch).run(request, async (call) =>
          Machine.ToolCallResult.parse(
            await typedCall(requireClient(), Machine.WireMethod.CallTool, call, request.timeoutMs),
          ),
        ),
      );
    },
  });
  try {
    const connected = await connecting;
    client = connected;
    // typedCall types the wire result but does not validate it; the host is
    // across a trust boundary, so parse before believing it.
    const attachment = Machine.AttachResult.parse(
      await typedCall(connected, Machine.WireMethod.Attach, offer, options.attachTimeoutMs),
    );
    return {
      attachment,
      sandbox,
      close() {
        closeKernels();
        fsOp.close();
        connected.close();
      },
    };
  } catch (error) {
    closeKernels();
    fsOp.close();
    // client stays unassigned when the connection itself failed; the transport
    // owns its own cleanup in that case.
    client?.close();
    throw error;
  }
}
