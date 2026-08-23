import { ChatAgent, type ChatAgentConfig } from "@openomni/agent";
import type { Model, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { DelegationOrigin } from "./admission";
import type { DelegationKernel } from "./kernel";
import type { InlineWorkerRunner } from "./inline-driver";
import { delegateToolSpec } from "./tool";
import { delegationToolExecutor } from "./tool-executor";

const WORKER_SYSTEM_PROMPT =
  "You are a Worker. Do the work you were handed and report what you found, plainly and without asking for confirmation. You may open a same-domain child worker for a piece of it; commissioning independent work is the Resident's call, not yours.";

export interface WorkerLoopOptions {
  readonly model: Model.Ref;
  readonly apiKey: string;
  readonly llm?: ChatAgentConfig["llm"];
  /** Resolved late: the kernel needs the runner this factory produces. */
  readonly kernel: () => DelegationKernel;
}

function instructionFor(input: Parameters<InlineWorkerRunner>[0]): string {
  if (input.acceptanceCriteria.length === 0) return input.instruction;
  return [
    input.instruction,
    "",
    "It is done when all of these hold:",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join("\n");
}

/**
 * A worker turn: its own loop, its own transcript, and the same delegate tool
 * the Resident holds — bound to a worker origin, so the depth rule applies to
 * it without the catalog having to know the rule.
 */
export function createInlineWorkerRunner(options: WorkerLoopOptions): InlineWorkerRunner {
  return async (input) => {
    const origin: DelegationOrigin = { role: "worker", depth: input.depth };
    const tools: Tool.Spec[] = [delegateToolSpec()];
    const kernel = options.kernel();

    const agent = ChatAgent.create({
      events: Bus,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      tools,
      toolExecutor: delegationToolExecutor(kernel, origin),
      model: options.model,
      auth: { type: "api", key: options.apiKey },
      signal: input.signal,
      ...(options.llm === undefined ? {} : { llm: options.llm }),
    });

    const result = await agent.run({
      messages: [{ role: "user", content: instructionFor(input), time: Date.now() }],
      traceContext: {
        traceId: crypto.randomUUID(),
        sessionId: `delegation-${input.delegationId}`,
        runId: crypto.randomUUID(),
        agentName: "worker",
      },
    });

    return result.text;
  };
}
