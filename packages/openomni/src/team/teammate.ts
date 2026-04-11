import { ChatAgent } from "@openomni/agent";
import type { ChatAgentConfig, AgentResult, TokenUsage } from "@openomni/agent";
import type { PlanStep, Tool } from "@openomni/protocol";

// fresh ChatAgent per call — no cross-step state
export namespace Teammate {
  export interface TeammateConfig {
    agentId: string;
    model: { provider: string; id: string };
    systemPrompt?: string;
    tools?: Tool.Spec[];
    budget?: ChatAgentConfig["budget"];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  }

  export interface ExecuteInput {
    step: PlanStep;
    context?: string;
    handoffDocument?: string;
  }

  export interface ExecuteResult {
    agentId: string;
    stepId: string;
    output: string;
    usage: TokenUsage;
    finishReason: string;
  }

  function buildUserMessage(input: ExecuteInput): string {
    const { step, context, handoffDocument } = input;

    let message = `Execute the following task:\n\nTask: ${step.description}\nExpected Output: ${step.expectedOutput}`;

    if (context) {
      message += `\n\nContext from previous steps:\n${context}`;
    }

    if (handoffDocument) {
      message += `\n\nHandoff from previous attempt:\n${handoffDocument}`;
    }

    return message;
  }

  // step tools take precedence over config tools with the same name
  function mergeTools(configTools?: Tool.Spec[], stepTools?: Tool.Spec[]): Tool.Spec[] | undefined {
    if (!configTools && !stepTools) return undefined;
    if (!configTools) return stepTools;
    if (!stepTools) return configTools;

    const merged = new Map<string, Tool.Spec>();
    for (const tool of configTools) {
      merged.set(tool.name, tool);
    }
    for (const tool of stepTools) {
      merged.set(tool.name, tool);
    }
    return [...merged.values()];
  }

  export async function execute(
    input: ExecuteInput,
    config: TeammateConfig,
  ): Promise<ExecuteResult> {
    const agentConfig: ChatAgentConfig = {
      model: config.model,
      systemPrompt: config.systemPrompt,
      tools: mergeTools(config.tools, input.step.tools),
      budget: config.budget,
      toolExecutor: config.toolExecutor,
    };

    const agent = ChatAgent.create(agentConfig);
    const userMessage = buildUserMessage(input);

    const result: AgentResult = await agent.run({
      messages: [{ role: "user", content: userMessage }],
    });

    return {
      agentId: config.agentId,
      stepId: input.step.stepId,
      output: result.text,
      usage: result.usage,
      finishReason: result.finishReason,
    };
  }
}
