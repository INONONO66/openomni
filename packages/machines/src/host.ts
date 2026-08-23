import { type IpcServer, createIpcServer } from "@openomni/ipc";
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
}

export interface MachineHost {
  /** Effective capability set of a currently attached machine. */
  attached(machineId: Machine.MachineId): readonly Machine.CapabilityId[] | undefined;
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

  function detach(connectionId: string, reason: string): void {
    const attachment = attachments.get(connectionId);
    if (!attachment) return;
    attachments.delete(connectionId);
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
    (method, params, respond, _notify, connectionId) => {
      if (method !== "machine.attach") {
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

  return {
    attached(machineId) {
      const connectionId = connectionByMachine.get(machineId);
      if (connectionId === undefined) return undefined;
      return attachments.get(connectionId)?.capabilities;
    },
    close() {
      server.close();
    },
  };
}
