import type { ChatAgentConfig } from "../types";
import type { RunState } from "./state";
import { recordToolCall } from "../budget";
import { Tool } from "@openomni/protocol";

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
  readonly allTools: Tool.Spec[];
  readonly executor: NonNullable<ChatAgentConfig["toolExecutor"]> | undefined;
}

export function prepareTurnTools(state: RunState, config: ChatAgentConfig): PreparedTurnTools {
  const allTools = config.tools ?? [];
  const configuredExecutor = config.toolExecutor;
  const executor = configuredExecutor
    ? async (call: Tool.Call, context?: Tool.ExecutionContext) => {
        const startedAt = Date.now();
        try {
          return await configuredExecutor(call, context);
        } finally {
          state.budgetState = recordToolCall(state.budgetState, Date.now() - startedAt);
        }
      }
    : undefined;
  return { allTools, executor };
}
