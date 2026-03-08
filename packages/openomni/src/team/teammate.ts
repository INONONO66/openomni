import { ChatAgent } from "@openomni/agent";
import type { ChatAgentConfig, AgentResult, TokenUsage } from "@openomni/agent";
import type { PlanStep, Tool } from "@openomni/protocol";

/**
 * Teammate namespace — wraps ChatAgent for step execution
 * Each execute() call creates a fresh ChatAgent instance (no cross-step state)
 */
export namespace Teammate {
  /**
   * Configuration for Teammate execution
   */
  export interface TeammateConfig {
    agentId: string;
    model: { provider: string; id: string };
    systemPrompt?: string;
    tools?: Tool.Spec[];
    budget?: ChatAgentConfig["budget"];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  }

  /**
   * Input to Teammate.execute()
   */
  export interface ExecuteInput {
    step: PlanStep;
    context?: string; // Optional context from previous steps
    handoffDocument?: string; // Optional handoff from previous attempt
  }

  /**
   * Result of Teammate.execute()
   */
  export interface ExecuteResult {
    agentId: string;
    stepId: string;
    output: string;
    usage: TokenUsage;
    finishReason: string;
  }

  /**
   * Build user message from ExecuteInput
   */
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

  /**
   * Merge config-level and step-level tools, deduplicating by name.
   * Step tools take precedence over config tools with the same name.
   */
  function mergeTools(
    configTools?: Tool.Spec[],
    stepTools?: Tool.Spec[],
  ): Tool.Spec[] | undefined {
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

  /**
   * Execute a single step using a fresh ChatAgent instance
   * Each call creates a NEW ChatAgent (no cross-step state)
   */
  export async function execute(
    input: ExecuteInput,
    config: TeammateConfig,
  ): Promise<ExecuteResult> {
    // Build ChatAgent config
    const agentConfig: ChatAgentConfig = {
      model: config.model,
      systemPrompt: config.systemPrompt,
      tools: mergeTools(config.tools, input.step.tools),
      budget: config.budget,
      toolExecutor: config.toolExecutor,
    };

    // Create fresh ChatAgent instance
    const agent = ChatAgent.create(agentConfig);

    // Build user message
    const userMessage = buildUserMessage(input);

    // Run agent
    const result: AgentResult = await agent.run({
      messages: [{ role: "user", content: userMessage }],
    });

    // Return ExecuteResult
    return {
      agentId: config.agentId,
      stepId: input.step.stepId,
      output: result.text,
      usage: result.usage,
      finishReason: result.finishReason,
    };
  }
}
