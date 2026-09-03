import { newTraceId } from "@openomni/telemetry";
import { ChatAgent, type ChatAgentConfig } from "@openomni/agent";
import type { Model } from "@openomni/protocol";
import { observeComponent } from "../observation/component";
import { buildAgentPrompt } from "../prompt/build";
import { WORKER_PRESET } from "../prompt/roles";
import { createTools } from "../tools/core/catalog";
import { createDispatcher, HOST_TARGET } from "../tools/core/dispatch";
import { decideDrive, initialDriveState, type DriveState } from "./drive-loop";
import { renderInstruction } from "./instruction";
import type { DelegationKernel } from "./kernel";
import type { InlineWorkerRunner } from "./inline-driver";

export class WorkerRunError extends Error {
  constructor(
    message: string,
    readonly runId: string,
  ) {
    super(message);
    this.name = "WorkerRunError";
  }
}

export interface WorkerLoopOptions {
  readonly model: Model.Ref;
  readonly apiKey: string;
  /** Operator-configured provider endpoint and headers; absent uses the catalog's. */
  readonly transport?: ChatAgentConfig["transport"];
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
    const sessionId = `delegation-${input.delegationId}`;
    const catalog = createDispatcher(createTools({ delegation: options.kernel() }, input.origin), sessionId);

    const messages: Array<{ role: "user" | "assistant"; content: string; time: number }> = [
      {
        role: "user",
        content: renderInstruction(input.instruction, input.acceptanceCriteria),
        time: Date.now(),
      },
    ];
    const traceId = newTraceId();

    // Assigned work is driven goal-style (drive-loop.ts); ask/notify runs
    // once — a question is answered, never nannied.
    let tokens = 0;
    let state: DriveState = initialDriveState();
    let firstRun = true;
    for (;;) {
      // The initial run identity is allocated during admission and recorded
      // on the commissioned WorkItem. Driven follow-ups remain distinct runs
      // for telemetry, while the attempt remains correlated to its first run.
      const runId =
        firstRun && input.workerRunId !== undefined ? input.workerRunId : crypto.randomUUID();
      firstRun = false;
      const observation = observeComponent({
        traceId,
        sessionId,
        runId,
        actorId: "worker",
        agentName: "worker",
        componentId: "worker.agent",
        componentGeneration: state.runs + 1,
        pluginName: "builtin.worker",
      });
      const agent = ChatAgent.create({
        events: observation.events,
        systemPrompt: buildAgentPrompt(WORKER_PRESET),
        tools: catalog.specs,
        toolTargets: [HOST_TARGET],
        toolExecutor: catalog.execute,
        model: options.model,
        auth: { type: "api", key: options.apiKey },
        ...(options.transport === undefined ? {} : { transport: options.transport }),
        signal: input.signal,
        ...(options.llm === undefined ? {} : { llm: options.llm }),
      });
      let result: Awaited<ReturnType<typeof agent.run>>;
      try {
        result = await observation.run(() =>
          agent.run({
            messages,
            traceContext: { traceId, sessionId, runId, agentName: "worker" },
          }),
        );
      } catch (error) {
        throw new WorkerRunError(error instanceof Error ? error.message : String(error), runId);
      }
      tokens += result.usage.totalTokens;
      if (input.operation !== "assign") return { text: result.text, tokens, runId };
      const decision = decideDrive(state, {
        text: result.text,
        finishReason: result.finishReason,
      });
      if (decision.action === "done") return { text: result.text, tokens, runId };
      if (decision.action === "stop") {
        return { text: `[drive stopped: ${decision.reason}]\n${result.text}`, tokens, runId };
      }
      state = decision.state;
      messages.push(
        { role: "assistant", content: result.text, time: Date.now() },
        { role: "user", content: decision.prompt, time: Date.now() },
      );
    }
  };
}
