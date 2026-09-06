import { Placement } from "@openomni/placement";
import type { ChatAgentConfig } from "../types";
import type { RunState } from "./state";
import { recordToolCall } from "../budget";
import { Tool } from "@openomni/protocol";

function toolPlacementRefusals(
  decisions: readonly Placement.ToolDecision[],
): ReadonlyMap<string, NonNullable<Tool.Spec["requires"]>> {
  const refused = new Map<string, NonNullable<Tool.Spec["requires"]>>();
  for (const decision of decisions) {
    if (decision.offerable) continue;
    const requires = decision.tool.requires ?? [];
    for (const name of Tool.executableNames(decision.tool.name)) refused.set(name, requires);
  }
  return refused;
}

export function refusedToolCall(
  call: Tool.Call,
  requires: NonNullable<Tool.Spec["requires"]>,
): Tool.Result {
  return {
    id: call.id,
    toolCallId: call.id,
    toolName: call.tool,
    output: `tool "${call.tool}" requires capabilities no attached target holds: ${requires.join(", ")}`,
    isError: true,
    settlement: "settled",
  };
}

export function buildSystemPrompt(
  basePrompt: string | undefined,
  tools: Tool.Spec[],
): string | undefined {
  const toolPrompts = tools
    .filter((t) => t.prompt)
    .map((t) => `## Tool: ${t.name}\n${t.prompt}`)
    .join("\n\n");

  if (!toolPrompts) return basePrompt;
  if (!basePrompt) return toolPrompts;
  return `${basePrompt}\n\n---\n\n${toolPrompts}`;
}

export function assertToolExecutor(config: ChatAgentConfig): void {
  if ((config.tools?.length ?? 0) > 0 && !config.toolExecutor && !config.toolWave) {
    throw new Error("toolExecutor is required when tools are provided");
  }
}

/**
 * Config-time validation: building the metadata map throws on a key
 * collision (see {@link buildToolMetadataMap}). Run alongside
 * `assertToolExecutor` so an ambiguous catalog refuses the run before it is
 * opened, instead of surfacing mid-turn as a retryable "tool" error.
 */
export function assertUnambiguousToolMetadata(config: ChatAgentConfig): void {
  buildToolMetadataMap(config.tools);
}

/**
 * Placement decides EXECUTION, not just advertisement. Filtering the catalog
 * only stops the model from being told about a tool; a model that names a
 * placement-filtered tool anyway (forged call, stale transcript, cached
 * catalog) must still be refused, or the capability requirement is
 * decorative. This wrapper is the single enforcement point for that refusal.
 *
 * It refuses ONLY tools this run's placement fold declared unofferable, under
 * every identity an executor can dispatch them by (`Tool.executableNames`).
 * Reservation is unconditional: a catalog where an offerable tool's literal
 * name is also a refused tool's alias is ambiguous at the executor's own
 * dispatch table, so the gate fails closed rather than resolving it by
 * catalog order. A name absent from the configured catalog is not a placement
 * matter — dynamic executors (MCP relays, host-registered tools) legitimately
 * resolve names the loop never listed, and rejecting those here would be
 * placement overreaching into tool resolution.
 *
 * `Placement.resolveTools` answers only what may be OFFERED, so this wrapper
 * is the other half: it refuses a call to a tool the placement fold declined
 * to offer, naming what was missing. Exported because every door into a tool
 * catalog needs it, and a second spelling of this refusal is how the two
 * would drift — the loop applies it to what the model calls; a host that
 * lets code call tools directly applies it to that door, which the loop
 * never sees.
 */
export function placementGatedExecutor(
  decisions: readonly Placement.ToolDecision[],
  execute: NonNullable<ChatAgentConfig["toolExecutor"]>,
): NonNullable<ChatAgentConfig["toolExecutor"]> {
  const refused = toolPlacementRefusals(decisions);
  if (refused.size === 0) return execute;
  return async (call, context) => {
    const requires = refused.get(call.tool);
    if (requires === undefined) return execute(call, context);
    return refusedToolCall(call, requires);
  };
}

type ToolPolicyMetadata = Pick<NonNullable<ChatAgentConfig["tools"]>[number], "descriptor"> & {
  readonly labels?: readonly string[];
};

function buildToolMetadataMap(tools: ChatAgentConfig["tools"]): Map<string, ToolPolicyMetadata> {
  const metadata = new Map<string, ToolPolicyMetadata>();
  // Every key names the tool that claimed it. Two tools resolving to the same
  // key (e.g. `a_b` alongside `a.b`, whose underscore-mangled alias is also
  // `a.b`) used to be a silent last-writer-wins — the later tool's labels
  // answered the earlier tool's policy lookups (#606 re-audit). A collision
  // is a configuration error; refuse it loudly, naming both tools.
  // Owners are keyed by tool IDENTITY, not name: two distinct tools carrying
  // the same name (the underscore-mangling seam can manufacture that) must
  // collide too, or the later one silently answers the earlier one's lookups.
  const owners = new Map<string, { readonly name: string; readonly tool: object }>();
  const claim = (key: string, tool: { name: string }, value: ToolPolicyMetadata): void => {
    const owner = owners.get(key);
    if (owner !== undefined && owner.tool !== tool) {
      throw new Error(
        `tool metadata collision: "${key}" is claimed by both "${owner.name}" and "${tool.name}"`,
      );
    }
    owners.set(key, { name: tool.name, tool });
    metadata.set(key, value);
  };
  for (const tool of tools ?? []) {
    const labels = tool.labels ?? tool.descriptor?.labels;
    if (labels === undefined && tool.descriptor === undefined) continue;
    const value = {
      ...(labels !== undefined && { labels }),
      ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
    };
    claim(tool.name, tool, value);
    const canonical = labels?.find((label) => label.startsWith("tool:"))?.slice(5);
    if (canonical) claim(canonical, tool, value);
    const dotted = tool.name.replace(/_/g, ".");
    if (dotted !== tool.name) claim(dotted, tool, value);
  }
  return metadata;
}

interface PreparedTurnTools {
  readonly refused: ReturnType<typeof toolPlacementRefusals>;
  readonly allTools: Tool.Spec[];
  readonly executor: NonNullable<ChatAgentConfig["toolExecutor"]> | undefined;
}

export function prepareTurnTools(state: RunState, config: ChatAgentConfig): PreparedTurnTools {
  const toolTargets = config.toolTargets ?? [{ kind: "host", capabilities: [] } as const];
  const placement = Placement.resolveTools(config.tools ?? [], toolTargets);
  const allTools = placement
    .filter((decision) => decision.offerable)
    .map((decision) => decision.tool);
  const configuredExecutor = config.toolExecutor;
  const executor = configuredExecutor
    ? placementGatedExecutor(placement, async (call, context) => {
        const startedAt = Date.now();
        try {
          return await configuredExecutor(call, context);
        } finally {
          state.budgetState = recordToolCall(state.budgetState, Date.now() - startedAt);
        }
      })
    : undefined;
  return { allTools, executor, refused: toolPlacementRefusals(placement) };
}
