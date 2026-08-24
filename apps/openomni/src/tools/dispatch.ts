import type { ChatAgentConfig } from "@openomni/agent";
import type { Placement } from "@openomni/placement";
import type { Tool } from "@openomni/protocol";

/**
 * The brain as a placement target. Declaring no capabilities is the honest
 * reading: the host runs host- and free-placed tools, and claims none of the
 * machine capabilities a `requires` could name.
 */
export const HOST_TARGET: Placement.ToolTarget = { kind: "host", capabilities: [] };

/** A tool as the app holds it: what the model is told, and what running it does. */
export interface CatalogEntry {
  readonly spec: Tool.Spec;
  run(input: unknown): Promise<string>;
}

export interface Dispatcher {
  /** The whole catalog. Who may be offered what is placement's question. */
  readonly specs: Tool.Spec[];
  /** Runs a call by name. Ungated: every door gates once, and states where. */
  readonly execute: NonNullable<ChatAgentConfig["toolExecutor"]>;
}

/**
 * Turns a catalog into "a name runs a tool", and nothing more.
 *
 * The two doors into this catalog gate differently, so neither gate lives
 * here: the agent loop gates what the model calls against the turn's targets,
 * and the cell door (`run-code.ts`) gates what a running cell calls against
 * the brain alone.
 */
export function createDispatcher(entries: readonly CatalogEntry[]): Dispatcher {
  const known = new Map(entries.map((entry) => [entry.spec.name, entry]));

  return {
    specs: entries.map((entry) => entry.spec),
    execute: async (call) => {
      const entry = known.get(call.tool);
      return entry === undefined
        ? {
            toolCallId: call.id,
            id: call.id,
            toolName: call.tool,
            output: `unknown tool: ${call.tool}`,
            isError: true,
          }
        : {
            toolCallId: call.id,
            id: call.id,
            toolName: call.tool,
            output: await entry.run(call.input),
          };
    },
  };
}
