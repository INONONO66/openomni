import type { Machine } from "@openomni/protocol";
import type { ChatAgentConfig } from "@openomni/agent";

/**
 * Which tools a running cell may reach back for, and on whose authority.
 *
 * A cell's `tool.<name>()` call carries a `cellId` and nothing about who
 * asked for the cell. Binding the catalog to the cell at dispatch time is
 * what keeps that from becoming an escalation: a cell serves exactly the
 * tools its own dispatcher holds, so giving code mode to a less privileged
 * loop later cannot silently hand it the Resident's reach.
 *
 * The host has already established that the `cellId` belongs to a cell it
 * dispatched and still awaits; this answers the separate question of what
 * that cell is allowed to do.
 */
export interface CellRegistry {
  bind(cellId: string, execute: NonNullable<ChatAgentConfig["toolExecutor"]>): void;
  release(cellId: string): void;
  /** The `callTool` port handed to the machine host. */
  callTool(call: Machine.ToolCall): Promise<Machine.ToolCallResult>;
}

export function createCellRegistry(): CellRegistry {
  const live = new Map<string, NonNullable<ChatAgentConfig["toolExecutor"]>>();

  return {
    bind(cellId, execute) {
      live.set(cellId, execute);
    },
    release(cellId) {
      live.delete(cellId);
    },
    async callTool(call) {
      const execute = live.get(call.cellId);
      if (execute === undefined) {
        return { status: "failed", error: `no tools are bound to cell ${call.cellId}` };
      }
      const result = await execute({
        id: `cell:${call.cellId}`,
        tool: call.name,
        input: call.arguments,
      });
      // A refused or failed tool is a value the cell can catch, not a
      // transport error: the contract's `failed` arm exists for exactly this.
      return result.isError === true
        ? { status: "failed", error: result.output }
        : { status: "completed", value: result.output };
    },
  };
}
