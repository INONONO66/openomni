import type { Ingress } from "@openomni/protocol";
import type { BrainEngine } from "./engine.js";

export namespace CronAdapter {
  export interface CronJob {
    id: string;
    agentName: string;
    payload: string;
    workspace?: string;
    target?: Ingress.Target;
  }

  export function fire(
    job: CronJob,
    engine: Pick<BrainEngine, "ingestInternal">,
    traceId: string,
  ): Promise<Ingress.IngressResult> {
    return engine.ingestInternal({
      id: crypto.randomUUID(),
      traceId,
      surface: "cron",
      mode: "internal",
      agentName: job.agentName,
      workspace: job.workspace,
      payload: job.payload,
      target: job.target ?? { kind: "resident" },
      meta: { actor: { role: "system", id: `cron:${job.id}` } },
      activation: {
        trigger: { kind: "cron", id: job.id, scheduledAt: Date.now(), firedAt: Date.now() },
      },
    });
  }
}
