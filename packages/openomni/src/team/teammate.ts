import { ChatAgent } from "@openomni/agent";
import type { ChatAgentConfig, AgentResult, TokenUsage } from "@openomni/agent";
import type { PlanStep, Tool } from "@openomni/protocol";

export namespace Teammate {
  export interface RuntimeTokenUsage {
    input: number;
    output: number;
    total: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  }

  export interface SubagentRuntimeRunResult {
    sessionId: string;
    runId: string;
    output: string;
    finishReason: string;
  }

  export interface SubagentRuntimeSpawnConfig {
    agentName: string;
    title: string;
    prompt: string;
    model: TeammateConfig["model"];
    systemPrompt?: string;
    tools?: Tool.Spec[];
    budget?: ChatAgentConfig["budget"];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  }

  export interface SubagentRuntimeSendConfig {
    sessionId: string;
    prompt: string;
    model: TeammateConfig["model"];
    systemPrompt?: string;
    tools?: Tool.Spec[];
    budget?: ChatAgentConfig["budget"];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
  }

  export interface SubagentRuntime {
    spawn: (config: SubagentRuntimeSpawnConfig) => Promise<SubagentRuntimeRunResult>;
    send: (config: SubagentRuntimeSendConfig) => Promise<SubagentRuntimeRunResult>;
  }

  export interface TeammateConfig {
    agentId: string;
    model: { provider: string; id: string };
    systemPrompt?: string;
    tools?: Tool.Spec[];
    budget?: ChatAgentConfig["budget"];
    toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
    subagentRuntime?: SubagentRuntime;
  }

  export interface ExecuteInput {
    step: PlanStep;
    context?: string;
    handoffDocument?: string;
    workerSessionId?: string;
  }

  export interface ExecuteResult {
    agentId: string;
    stepId: string;
    output: string;
    usage: TokenUsage | RuntimeTokenUsage;
    finishReason: string;
    workerSessionId?: string;
    workerRunId?: string;
  }

  function createRuntimeTokenUsage(): RuntimeTokenUsage {
    return {
      input: 0,
      output: 0,
      total: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
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
    const userMessage = buildUserMessage(input);
    const tools = mergeTools(config.tools, input.step.tools);

    if (config.subagentRuntime) {
      const result = input.workerSessionId
        ? await config.subagentRuntime.send({
            sessionId: input.workerSessionId,
            prompt: userMessage,
            model: config.model,
            systemPrompt: config.systemPrompt,
            tools,
            budget: config.budget,
            toolExecutor: config.toolExecutor,
          })
        : await config.subagentRuntime.spawn({
            agentName: config.agentId,
            title: input.step.description.slice(0, 60),
            prompt: userMessage,
            model: config.model,
            systemPrompt: config.systemPrompt,
            tools,
            budget: config.budget,
            toolExecutor: config.toolExecutor,
          });

      return {
        agentId: config.agentId,
        stepId: input.step.stepId,
        output: result.output,
        usage: createRuntimeTokenUsage(),
        finishReason: result.finishReason,
        workerSessionId: result.sessionId,
        workerRunId: result.runId,
      };
    }

    const agentConfig: ChatAgentConfig = {
      model: config.model,
      systemPrompt: config.systemPrompt,
      tools,
      budget: config.budget,
      toolExecutor: config.toolExecutor,
    };

    const agent = ChatAgent.create(agentConfig);

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
