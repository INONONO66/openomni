import { ChatAgent, type ChatAgentConfig } from "@openomni/agent";
import type { Model } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { catalogEntries } from "../tools/catalog";
import { createDispatcher, HOST_TARGET } from "../tools/dispatch";
import { renderInstruction } from "./instruction";
import type { DelegationKernel } from "./kernel";
import type { InlineWorkerRunner } from "./inline-driver";

const WORKER_SYSTEM_PROMPT =
  "You are a Worker. Do the work you were handed and report what you found, plainly and without asking for confirmation. You may open a same-domain child worker for a piece of it; commissioning independent work is the Resident's call, not yours.";

export interface WorkerLoopOptions {
  readonly model: Model.Ref;
  readonly apiKey: string;
  readonly llm?: ChatAgentConfig["llm"];
  /** Resolved late: the kernel needs the runner this factory produces. */
  readonly kernel: () => DelegationKernel;
}

/**
 * A worker turn: its own loop, its own transcript, and the same delegate tool
 * the Resident holds — bound to a worker origin, so the depth rule applies to
 * it without the catalog having to know the rule. It is handed no machines:
 * code mode is the Resident's for now, and an unwired port is simply absent
 * from a worker's catalog.
 */
export function createInlineWorkerRunner(options: WorkerLoopOptions): InlineWorkerRunner {
  return async (input) => {
    const catalog = createDispatcher(catalogEntries({ delegation: options.kernel() }, input.origin));

    const agent = ChatAgent.create({
      events: Bus,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      tools: catalog.specs,
      toolTargets: [HOST_TARGET],
      toolExecutor: catalog.execute,
      model: options.model,
      auth: { type: "api", key: options.apiKey },
      signal: input.signal,
      ...(options.llm === undefined ? {} : { llm: options.llm }),
    });

    const result = await agent.run({
      messages: [
        {
          role: "user",
          content: renderInstruction(input.instruction, input.acceptanceCriteria),
          time: Date.now(),
        },
      ],
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
