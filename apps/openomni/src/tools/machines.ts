import type { Tool } from "@openomni/protocol";
import { z } from "zod";

/**
 * One machine as the Resident sees it: enrolled always, attached sometimes,
 * reduced to what it may actually do (the Enrollment∩Offer effective fold —
 * the composition root reads it from the host attachment table).
 */
export interface MachineStatus {
  readonly machineId: string;
  readonly attached: boolean;
  readonly capabilities: readonly string[];
}

export type MachinesPort = () => readonly MachineStatus[];

const Input = z.object({}).strict();

export const MACHINES_TOOL_NAME = "machines";

export function machinesToolSpec(): Tool.Spec {
  return {
    name: MACHINES_TOOL_NAME,
    description:
      "List the machines this system is enrolled with: which are attached right now and what each may do. Use it to pick the machineId a run_code cell targets.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    safe: true,
    placement: "host",
  };
}

function describeMachine(machine: MachineStatus): string {
  if (!machine.attached) return `${machine.machineId} — enrolled, not attached right now`;
  if (machine.capabilities.length === 0) {
    return `${machine.machineId} — attached, no effective capabilities`;
  }
  return `${machine.machineId} — attached, may: ${[...machine.capabilities].sort().join(", ")}`;
}

export function machinesToolExecutor(machines: MachinesPort) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = Input.safeParse(rawInput);
    if (!parsed.success) {
      return `machines refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const statuses = machines();
    if (statuses.length === 0) return "No machines are enrolled.";
    return statuses.map(describeMachine).join("\n");
  };
}
