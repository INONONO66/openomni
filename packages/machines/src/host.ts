import { chmodSync } from "node:fs";
import { type IpcServer, createIpcServer, typedCall } from "@openomni/ipc";
import { type BusEvent, Machine } from "@openomni/protocol";

export interface MachineHostOptions {
  readonly socketPath: string;
  /**
   * Owner enrollment lookup, injected by the composition root. The host is
   * ledger-free by the driver-band rule; whoever wires it decides where
   * enrollments persist.
   */
  readonly enrollment: (machineId: Machine.MachineId) => Machine.Enrollment | undefined;
  readonly events: BusEvent.Sink;
  readonly now: () => number;
  /**
   * Runs a `tool.<name>()` call made from inside a cell. Injected by the
   * composition root, which supplies the SAME placement-gated executor the
   * model-facing catalog uses — so a tool the placement fold refused cannot be
   * reached by spelling its name in code. A host wired without this port
   * exposes no tools, and says so.
   */
  readonly callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>;
}

/**
 * The daemon owns the cell deadline and answers an overrun with an honest
 * `timed_out` result. The host RPC deadline must therefore outlast the cell's
 * own, or the host would report a transport failure for a cell the daemon is
 * about to report on truthfully; this is the margin for that reply.
 */
const CELL_REPLY_GRACE_MS = 1000;

export type RunCellOutcome =
  | Machine.CellResult
  | {
      readonly status: "refused";
      readonly reason: "machine_not_attached" | "kernel_not_available";
    };

export interface MachineHost {
  /** Effective capability set of a currently attached machine. */
  attached(machineId: Machine.MachineId): readonly Machine.CapabilityId[] | undefined;
  runCell(machineId: Machine.MachineId, request: Machine.CellRequest): Promise<RunCellOutcome>;
  close(): void;
}

interface Attachment {
  readonly machineId: Machine.MachineId;
  readonly capabilities: readonly Machine.CapabilityId[];
}

/**
 * Brain-side accept endpoint for machine daemons (docs/machines-and-delegation.md §2).
 * Owns the `machine.attach` wire method: parse the Offer, fold it against the
 * injected enrollment, answer attached|refused, and keep the live attachment
 * table so detach (connection loss or re-attach supersession) is observable
 * through the injected event sink.
 */
export async function createMachineHost(options: MachineHostOptions): Promise<MachineHost> {
  // Keyed by connectionId: one attachment per connection, and a machine
  // re-attaching over a NEW connection supersedes the stale one (daemon
  // restart is the normal path, not an error).
  const attachments = new Map<string, Attachment>();
  const connectionByMachine = new Map<Machine.MachineId, string>();
  // Cells this host has in flight on each connection. A tool call is only
  // served on behalf of a cell the host itself dispatched and is still
  // waiting on, so `cellId` is a fact the host can stand behind rather than
  // an attribution the daemon asserts.
  const inFlight = new Map<string, Set<string>>();

  function detach(connectionId: string, reason: string): void {
    const attachment = attachments.get(connectionId);
    if (!attachment) return;
    attachments.delete(connectionId);
    // Housekeeping, not enforcement: the attachment check above already
    // refuses a detached connection. This just stops an empty set per dead
    // connection from accumulating on a long-lived host.
    inFlight.delete(connectionId);
    if (connectionByMachine.get(attachment.machineId) === connectionId) {
      connectionByMachine.delete(attachment.machineId);
    }
    options.events.publish(Machine.Events.Detached, {
      machineId: attachment.machineId,
      time: options.now(),
      reason,
    });
  }

  const server: IpcServer = await createIpcServer(
    options.socketPath,
    async (method, params, respond, _notify, connectionId) => {
      if (method === Machine.WireMethod.CallTool) {
        // Only an attached machine may reach the host's tools; the attachment
        // table is the authority, not anything the caller claims.
        if (!attachments.has(connectionId)) {
          throw new Error("machine is not attached");
        }
        const call = Machine.ToolCall.parse(params);
        if (!inFlight.get(connectionId)?.has(call.cellId)) {
          throw new Error(`no cell in flight: ${call.cellId}`);
        }
        respond(
          options.callTool
            ? await options.callTool(call)
            : ({ status: "failed", error: "this host exposes no tools" } satisfies Machine.ToolCallResult),
        );
        return;
      }
      if (method !== Machine.WireMethod.Attach) {
        throw new Error(`unknown method: ${method}`);
      }
      const offer = Machine.Offer.parse(params);
      const enrollment = options.enrollment(offer.machineId);
      if (enrollment === undefined) {
        respond({ status: "refused", reason: "machine_not_enrolled" } satisfies Machine.AttachResult);
        return;
      }
      const outcome = Machine.effectiveCapabilities(enrollment, offer);
      if (outcome.kind === "machine_mismatch") {
        respond({ status: "refused", reason: "machine_mismatch" } satisfies Machine.AttachResult);
        return;
      }
      const stale = connectionByMachine.get(outcome.machineId);
      if (stale !== undefined && stale !== connectionId) {
        detach(stale, "superseded_by_reattach");
      }
      detach(connectionId, "superseded_by_reattach");
      attachments.set(connectionId, {
        machineId: outcome.machineId,
        capabilities: outcome.capabilities,
      });
      connectionByMachine.set(outcome.machineId, connectionId);
      options.events.publish(Machine.Events.Attached, {
        machineId: outcome.machineId,
        time: options.now(),
        effectiveCapabilities: [...outcome.capabilities],
      });
      respond({
        status: "attached",
        effectiveCapabilities: [...outcome.capabilities],
      } satisfies Machine.AttachResult);
    },
    {
      onDisconnect: (connectionId) => detach(connectionId, "connection_closed"),
    },
  );
  // The localhost slice carries no auth token: the socket itself is the
  // trust boundary, so it must not be connectable by other local users.
  chmodSync(options.socketPath, 0o600);

  return {
    attached(machineId) {
      const connectionId = connectionByMachine.get(machineId);
      if (connectionId === undefined) return undefined;
      return attachments.get(connectionId)?.capabilities;
    },
    async runCell(machineId, request) {
      const connectionId = connectionByMachine.get(machineId);
      if (connectionId === undefined) {
        return { status: "refused", reason: "machine_not_attached" };
      }
      const attachment = attachments.get(connectionId);
      if (!attachment?.capabilities.includes(Machine.WellKnownCapability.pythonKernel)) {
        return { status: "refused", reason: "kernel_not_available" };
      }
      server.useConnection(connectionId);
      const cells = inFlight.get(connectionId) ?? new Set<string>();
      cells.add(request.cellId);
      inFlight.set(connectionId, cells);
      try {
        return Machine.CellResult.parse(
          await typedCall(
            server,
            Machine.WireMethod.RunCell,
            request,
            request.timeoutMs + CELL_REPLY_GRACE_MS,
          ),
        );
      } finally {
        cells.delete(request.cellId);
      }
    },
    close() {
      server.close();
    },
  };
}
