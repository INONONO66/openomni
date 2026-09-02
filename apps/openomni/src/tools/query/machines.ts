import { z } from "zod";
import { defineTool } from "../core/define";

export interface MachineStatus {
  readonly machineId: string;
  readonly attached: boolean;
  readonly capabilities: readonly string[];
  readonly effectiveExports?: readonly string[];
}
export type MachinesPort = () => readonly MachineStatus[];
const Input = z.object({}).strict();
const Output = z.array(z.object({
  machineId: z.string(), attached: z.boolean(), capabilities: z.array(z.string()), effectiveExports: z.array(z.string()).optional(),
}).strict());
export const MACHINES_TOOL_NAME = "machines";

function machinesToolExecutor(machines: MachinesPort) {
  return async (_input: z.output<typeof Input>): Promise<z.output<typeof Output>> => [...machines()].map((machine) => ({
    machineId: machine.machineId,
    attached: machine.attached,
    capabilities: [...machine.capabilities],
    ...(machine.effectiveExports === undefined ? {} : { effectiveExports: [...machine.effectiveExports] }),
  }));
}
function describeExports(machine: z.output<typeof Output>[number]): string {
  const exports = machine.effectiveExports ?? [];
  if (exports.length === 0) return "";
  return `; files: ${[...exports].sort().map((name) => `/machines/${machine.machineId}/${name}`).join(", ")}`;
}
function describeMachine(machine: z.output<typeof Output>[number]): string {
  if (!machine.attached) return `${machine.machineId} — enrolled, not attached right now`;
  if (machine.capabilities.length === 0) return `${machine.machineId} — attached, no effective capabilities`;
  return `${machine.machineId} — attached, may: ${[...machine.capabilities].sort().join(", ")}${describeExports(machine)}`;
}
export const machinesTool = defineTool({
  name: MACHINES_TOOL_NAME, category: "query",
  description: "List the machines this system is enrolled with: which are attached right now and what each may do. Use it to pick the machineId a run_code cell targets.",
  input: Input, output: Output, safe: true, execution: { kind: "host" }, placement: "host",
  visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
  bind: (ports) => ports.machines === undefined ? undefined : machinesToolExecutor(ports.machines),
  render: (_args, statuses) => statuses.length === 0 ? "No machines are enrolled." : statuses.map(describeMachine).join("\n"),
});
