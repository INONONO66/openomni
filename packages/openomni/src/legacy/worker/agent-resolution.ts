import type { Run, Sink, Tool } from "@openomni/protocol";
import { ModelsDev, Provider, run as llmRun, type RunInput } from "@openomni/llm";
import { BuiltinAgentRegistry, type AgentDefinition } from "../agent";
import type { ToolExecutor, OrchestratorRunInput } from "./run";

const DEFAULT_MODEL_CONFIG = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-20250514",
} as const;

const fallbackToolExecutor: ToolExecutor = {
  async execute(calls: Tool.Call[]): Promise<Tool.Result[]> {
    return calls.map((call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: `Tool '${call.tool}' is not configured`,
      isError: true,
    }));
  },
};

export function resolveAgentDefinition(agentId?: string): AgentDefinition | undefined {
  if (!agentId) return undefined;
  return BuiltinAgentRegistry.get(agentId);
}

export async function resolveLLM(model?: {
  providerID: string;
  modelID: string;
}): Promise<OrchestratorRunInput["llm"]> {
  const config = model ?? DEFAULT_MODEL_CONFIG;

  try {
    const providerModel = await resolveProviderModel(config);
    return createLLMRunner(providerModel);
  } catch (error) {
    if (model !== undefined) {
      console.warn(
        "[AgentResolution] Model resolution failed for",
        model,
        "- falling back to default. Error:",
        error,
      );
      return resolveLLM(undefined);
    }
    throw error;
  }
}

async function resolveProviderModel(config: {
  providerID: string;
  modelID: string;
}): Promise<Provider.Model> {
  const data = await ModelsDev.get();
  const providerData = data[config.providerID];

  if (!providerData) {
    throw new Error(`Provider not found: ${config.providerID}`);
  }

  const rawModel = providerData.models?.[config.modelID];
  if (!rawModel) {
    throw new Error(`Model not found: ${config.modelID} for provider ${config.providerID}`);
  }

  return Provider.fromModelsDevModel(providerData, rawModel as ModelsDev.Model);
}

// Bridges Provider.Model → OrchestratorRunInput["llm"] by wrapping
// the llm package's run() function with the resolved model.
function createLLMRunner(providerModel: Provider.Model): OrchestratorRunInput["llm"] {
  return {
    async run(input: Record<string, unknown>, sink: Sink): Promise<Run.Outcome> {
      const runInput: RunInput = {
        messages: (input.messages ?? []) as RunInput["messages"],
        tools: (input.tools ?? []) as RunInput["tools"],
        system: (input.system as string) ?? "",
        model: providerModel,
      };

      return llmRun(runInput, sink);
    },
  };
}

export function resolveToolExecutor(tools: string[]): ToolExecutor {
  if (tools.length === 0) {
    return fallbackToolExecutor;
  }

  const allowedTools = new Set(tools);

  // Permission-filtering executor: rejects disallowed tools. Allowed tools
  // also return error here because actual execution is delegated upstream
  // by the calling context (e.g., SubagentTool, DispatchCoordinator).
  return {
    async execute(calls: Tool.Call[]): Promise<Tool.Result[]> {
      return calls.map((call) => {
        if (!allowedTools.has(call.tool)) {
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Tool '${call.tool}' is not allowed for this agent. Allowed: ${tools.join(", ")}`,
            isError: true,
          };
        }

        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `Tool '${call.tool}' is allowed but no executor is registered`,
          isError: true,
        };
      });
    },
  };
}

export async function resolveAgentForWorker(agentId: string): Promise<{
  llm: OrchestratorRunInput["llm"];
  input: Partial<OrchestratorRunInput["input"]>;
  toolExecutor: ToolExecutor;
}> {
  const agentDef = resolveAgentDefinition(agentId);

  if (!agentDef) {
    const llm = await resolveLLM(undefined);
    return {
      llm,
      input: {},
      toolExecutor: fallbackToolExecutor,
    };
  }

  const llm = await resolveLLM(agentDef.model);
  const toolExecutor = resolveToolExecutor(agentDef.tools);

  return {
    llm,
    input: {
      ...(agentDef.systemPrompt ? { system: agentDef.systemPrompt } : {}),
    },
    toolExecutor,
  };
}

export { fallbackToolExecutor };
