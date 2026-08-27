import { ChatAgent, type ChatAgentConfig } from "@openomni/agent";
import type { Model } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { buildAgentPrompt } from "../prompt/build";
import { WORKER_PRESET } from "../prompt/roles";
import { catalogEntries } from "../tools/catalog";
import { createDispatcher, HOST_TARGET } from "../tools/dispatch";
import { decideDrive, initialDriveState, type DriveState } from "./drive-loop";
import { renderInstruction } from "./instruction";
import type { DelegationKernel } from "./kernel";
import type { InlineWorkerRunner } from "./inline-driver";

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
      systemPrompt: buildAgentPrompt(WORKER_PRESET),
      tools: catalog.specs,
      toolTargets: [HOST_TARGET],
      toolExecutor: catalog.execute,
      model: options.model,
      auth: { type: "api", key: options.apiKey },
      signal: input.signal,
      ...(options.llm === undefined ? {} : { llm: options.llm }),
    });

    const messages: Array<{ role: "user" | "assistant"; content: string; time: number }> = [
      {
        role: "user",
        content: renderInstruction(input.instruction, input.acceptanceCriteria),
        time: Date.now(),
      },
    ];
    const traceContext = {
      traceId: crypto.randomUUID(),
      sessionId: `delegation-${input.delegationId}`,
      runId: crypto.randomUUID(),
      agentName: "worker",
    };

    // Assigned work is driven goal-style (drive-loop.ts); ask/notify runs
    // once — a question is answered, never nannied.
    let tokens = 0;
    let state: DriveState = initialDriveState();
    for (;;) {
      const result = await agent.run({ messages, traceContext });
      tokens += result.usage.totalTokens;
      if (input.operation !== "assign") return { text: result.text, tokens };
      const decision = decideDrive(state, {
        text: result.text,
        finishReason: result.finishReason,
      });
      if (decision.action === "done") return { text: result.text, tokens };
      if (decision.action === "stop") {
        return { text: `[drive stopped: ${decision.reason}]\n${result.text}`, tokens };
      }
      state = decision.state;
      messages.push(
        { role: "assistant", content: result.text, time: Date.now() },
        { role: "user", content: decision.prompt, time: Date.now() },
      );
    }
  };
}
