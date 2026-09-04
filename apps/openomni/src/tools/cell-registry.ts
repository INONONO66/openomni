import type { Machine } from "@openomni/protocol";
import type { ChatAgentConfig } from "@openomni/agent";
import type { ToolExecutionContext } from "@openomni/protocol";

/**
 * Which tools a running cell may reach back for.
 *
 * A `tool.<name>()` call arrives identified only by `cellId`, so binding the
 * catalog to the cell at dispatch time is what lets a less privileged loop be
 * given code mode later without inheriting the Resident's reach: each cell
 * serves exactly the tools its own dispatcher held.
 *
 * That binding is not itself the boundary, and this map must not be mistaken
 * for one. Anyone who can name a live `cellId` here gets that cell's tools.
 * What makes the id unforgeable is upstream: the cell's own code never states
 * it — the daemon stamps the id of the cell it is running onto each frame,
 * and the host serves a frame only from the connection that cell was
 * dispatched to, and only while it is still in flight.
 */
export interface CellRegistry {
  bind(
    cellId: string,
    execute: NonNullable<ChatAgentConfig["toolExecutor"]>,
    parent: ToolExecutionContext,
  ): void;
  release(cellId: string): void;
  /** The `callTool` port handed to the machine host. */
  callTool(call: Machine.ToolCall): Promise<Machine.ToolCallResult>;
}

export function createCellRegistry(): CellRegistry {
  const live = new Map<
    string,
    {
      readonly execute: NonNullable<ChatAgentConfig["toolExecutor"]>;
      readonly parent: ToolExecutionContext;
    }
  >();

  return {
    bind(cellId, execute, parent) {
      live.set(cellId, { execute, parent });
    },
    release(cellId) {
      live.delete(cellId);
    },
    async callTool(call) {
      const bound = live.get(call.cellId);
      if (bound === undefined) {
        return { status: "failed", error: `no tools are bound to cell ${call.cellId}` };
      }
      const result = await bound.execute(
        {
          id: `cell:${call.cellId}:${crypto.randomUUID()}`,
          tool: call.name,
          input: call.arguments,
        },
        {
          signal: bound.parent.signal,
          traceContext: {
            traceId: bound.parent.turnId,
            sessionId: bound.parent.sessionId,
            runId: bound.parent.turnId,
          },
        },
      );
      // A refused or failed tool is a value the cell can catch, not a
      // transport error: the contract's `failed` arm exists for exactly this.
      return result.isError === true
        ? { status: "failed", error: result.output }
        : { status: "completed", value: result.output };
    },
  };
}
